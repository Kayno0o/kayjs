import type { Attribute, AwaitBranch, AwaitNode, ConstNode, ElementNode, ErrorNode, ForNode, IfBranch, IfNode, MatchNode, NamedAttribute, Node, SlotNode, SnippetNode, Span, TemplateFacts, TextNode, TryNode } from './ast'
import type { CodeBuilder } from './mapping'
import type { Sites } from './rewrite'
import { actionOf, FIELD_ATTRIBUTE, FIELD_ELEMENTS, isSlot, keyedByPosition, partAttribute, serverIslandOf } from './ast'
import { isFunctionAt, sentParts } from './expression'
import { slotValue } from './items'
import { DYNAMIC_TAG } from './mapping'
import { addBindWrite, bindRead, helperName } from './markup'
import { bindEvent, bindProblem } from './validate'

// A subject holding a call, which TypeScript does not narrow in a `switch`.
const CALLED = /[\w$\])]\s*\(/
// A subject that narrows by its type or its condition, which the lint for a `match` with no `else` leaves alone.
const TYPED_SUBJECT = /^(?:typeof\s|true$|false$)/
// A `when` value of a unit type: a literal, or an enum member written `Level.Low`; any other value may hold a union, which narrows nothing.
const UNIT_VALUE = /^(?:'[^'\\]*'|"[^"\\]*"|-?\d[\w.]*|true|false|null|undefined|[A-Z][\w$]*(?:\.[a-z_$][\w$]*)+)$/i

export interface JsxOptions {
  // `kay check`'s output: links, form fields and island props asserted through the globals it declares.
  check: boolean
  // Rows of a loop get their item rather than an accessor to it, as nothing here renders again.
  staticLoops: boolean
  // The props passed an island reach the browser as they are written, so `kay check` asserts they can.
  sendsIslandProps: boolean
}

// JSX collapses a run of spaces in text, which `pre` and `textarea` would show, so a run goes out as a string.
const JSX_TEXT_ESCAPES = /[{}<>]|[ \t]{2,}/g
const FORM_FIELDS = new Set(['input', 'select', 'textarea', 'button'])
const LINK_ELEMENTS = new Set(['a', 'area'])
// Attributes rendered as markup rather than text.
const MARKUP_ATTRIBUTES = new Set(['innerHTML', 'srcdoc'])
// URLs checked as links are when written out: an expression there may be another kind of value, such as an action a form posts to.
const WRITTEN_URLS = new Map([['img', 'src'], ['link', 'href'], ['form', 'action']])
const WHITESPACE = /\s+/
const EVENT_HANDLER = /^on[A-Z]/
const PLAIN_PARAMETER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

// A template as JSX: what the analysis pass reads for scope, and `kay check` type-checks.
export class JsxTemplate {
  constructor(private readonly b: CodeBuilder, private readonly src: string, private readonly facts: TemplateFacts, private readonly options: JsxOptions, private readonly sites: Sites) {}

  emitRoot(nodes: Node[]): void {
    const visible = this.withoutSlots(nodes)

    if (visible.length === 1 && visible[0]!.kind === 'element' && !isSlot(visible[0])) {
      this.emitElement(visible[0])

      return
    }

    if (visible.length === 0) {
      this.b.add('null')

      return
    }

    this.b.add('<>')
    this.emitChildren(visible)
    this.b.add('</>')
  }

  // Branch and loop bodies as one expression: a lone element stays bare, several get a fragment.
  emitChildren(nodes: Node[]): void {
    let previous: Node | undefined

    for (const [index, node] of nodes.entries()) {
      switch (node.kind) {
        case 'const':
          this.emitConst(node, nodes.slice(index + 1))

          return
        case 'snippet':
          this.emitSnippet(node, nodes.slice(index + 1))

          return
        case 'element':
          this.emitElement(node)

          break
        case 'text':
          // JSX folds a line break into a space, so the line break between two text lines is an expression.
          if (previous?.kind === 'text')
            this.b.add('{"\\n"}')

          this.emitText(node)

          break
        case 'if':
          this.b.wrap(node, () => {
            this.b.add('{')
            this.emitIf(node, 0)
            this.b.add('}')
          })

          break
        case 'match':
          this.b.wrap(node, () => {
            this.b.add('{')
            this.emitMatch(node)
            this.b.add('}')
          })

          break
        case 'for':
          this.emitFor(node)

          break
        case 'await':
          this.emitAwait(node)

          break
        case 'try':
          this.emitTry(node)

          break
        case 'error':
          this.emitError(node)

          break
        case 'pending':
          this.emitChildren(node.children)

          break
        // Passed to the component above it, or reported as misplaced.
        case 'slot':
          break
      }

      previous = node
    }
  }

  // The siblings after a `const` render inside a function declaring it, so its name reaches them and their children alone.
  private emitConst(node: ConstNode, rest: Node[]) {
    const { b } = this

    b.add('{(() => { ')
    b.wrap(node, () => {
      b.add('const ')
      // Code that runs reads it as a memo, as it does a row, unless the markup renders once.
      this.sites.consts.set(b.code.length, !this.options.staticLoops)

      b.addSource(node.pattern).add(' = (').addSource(node.value).add(');')
    })
    b.add(' return ')
    this.emitRoot(rest)
    b.add(' })()}')
  }

  // The siblings after a `snippet` render inside a function declaring it, as after a `const`; its return type is spelled out so it can call itself.
  private emitSnippet(node: SnippetNode, rest: Node[]) {
    const { b } = this

    b.add('{(() => { ')
    b.wrap(node, () => {
      b.add('const ')
      this.sites.snippets.add(b.code.length)
      b.addSource(node.name).add(' = (').addSource(node.params).add('): KayJSX.Element => (')
      this.emitRoot(node.children)
      b.add(');')
    })
    b.add(' return ')
    this.emitRoot(rest)
    b.add(' })()}')
  }

  // The field's name is typed as a `name` is: one of the action's input.
  private emitError(node: ErrorNode) {
    const { b } = this
    const target = this.facts.forms.get(node)

    if (!target || !this.options.check)
      return

    b.wrap(node, () => {
      b.add('{KayFormError((').addSource(target).add(')')

      if (node.field) {
        b.add(', ')
        b.wrap(node.field, () => b.add(JSON.stringify(node.name)))
      }

      b.add(')}')
    })
  }

  // A `switch`, so `kay check` narrows the subject in each branch and reports a value its type cannot hold.
  // With no `else`, `kay check` also gets a `default` handing what the branches left to `KayUnmatched`, which reports the members of a finite union they missed.
  private emitMatch(node: MatchNode) {
    const { b } = this
    const { fallback } = node
    const text = (span: Span) => this.src.slice(span.start, span.end).trim()
    const subject = text(node.subject)
    const unmatched = this.options.check && !fallback && !TYPED_SUBJECT.test(subject) && node.cases.every(branch => branch.values.every(value => UNIT_VALUE.test(text(value))))
    // A call is read once into a name, which then narrows by what the branches match; any other subject is the `switch`'s own, so it narrows what it is read off in the branches.
    const called = CALLED.test(subject)

    b.add('(() => { ')

    if (unmatched && called)
      b.add('const kayMatched = (').addSource(node.subject).add('); switch (kayMatched) { ')
    else
      b.add('switch (').addSource(node.subject).add(') { ')

    for (const branch of node.cases) {
      b.wrap(branch, () => {
        for (const value of branch.values)
          b.add('case ').addSource(value).add(': ')

        b.add('return (')
        this.emitRoot(branch.children)
        b.add('); ')
      })
    }

    if (fallback) {
      b.wrap(fallback, () => {
        b.add('default: return (')
        this.emitRoot(fallback.children)
        b.add('); ')
      })
    }

    if (unmatched) {
      if (called)
        b.add('default: KayUnmatched(kayMatched); ')
      else
        b.add('default: KayUnmatched((').addSource(node.subject).add(')); ')
    }

    b.add(fallback ? '} })()' : '} return null })()')
  }

  private emitIf(node: IfNode, index: number) {
    const branch = node.branches[index]!
    const { b } = this

    b.wrap(branch, () => {
      const hasRest = index + 1 < node.branches.length || node.fallback !== undefined

      if (branch.alias && this.options.check) {
        this.emitCheckedAlias(node, index, branch)

        return
      }

      if (branch.alias) {
        b.add(`<${helperName('Show')} when={`).addSource(branch.test).add('}')

        if (hasRest) {
          b.add(' fallback={')
          this.emitIfRest(node, index + 1)
          b.add('}')
        }

        b.add('>{(')
        this.sites.rows.add(b.code.length)
        b.addSource(branch.alias).add(') => ')
        this.emitRoot(branch.children)
        b.add(`}</${helperName('Show')}>`)

        return
      }

      b.add('(').addSource(branch.test).add(') ? ')
      this.emitRoot(branch.children)
      b.add(' : ')
      this.emitIfRest(node, index + 1)
    })
  }

  // The type checker reads an aliased block as a ternary calling its block on the spot, which TypeScript runs inline, so a property path the condition or an enclosing block narrowed stays narrowed inside it, as a callback would drop.
  private emitCheckedAlias(node: IfNode, index: number, branch: IfBranch) {
    const { b } = this

    // The condition is written twice and only the second is mapped to the source: a rule about a condition, such as strict-boolean-expressions on a nullable string, was never run on an aliased `if`, whose condition the browser build reads as a value.
    b.add('(').addUnmapped(branch.test).add(') ? ((')
    this.sites.rows.add(b.code.length)
    b.addSource(branch.alias!).add(') => ')
    this.emitRoot(branch.children)
    b.add(')(KayTruthy((').addSource(branch.test).add('))) : ')
    this.emitIfRest(node, index + 1)
  }

  // What renders when the branches before `index` all fail: the next one, else the `else` block.
  private emitIfRest(node: IfNode, index: number) {
    const { fallback } = node

    if (index < node.branches.length)
      this.emitIf(node, index)
    else if (fallback)
      this.b.wrap(fallback, () => this.emitRoot(fallback.children))
    else
      this.b.add('null')
  }

  // The blocks are values rather than functions, the `then` and `catch` ones called at once, so `kay check` keeps what an enclosing `if` or `match` narrowed, as a callback would drop for a property path.
  private emitAwait(node: AwaitNode) {
    const { b } = this

    b.wrap(node, () => {
      b.add('{(() => { const kayAwaited = (').addSource(node.value).add('); return <KayAwait ')
      // An error about the value lands on the value itself.
      b.wrap(node.value, () => b.add('value'))
      b.add('={kayAwaited}')

      if (node.pending.length > 0) {
        b.add(' pending={')
        this.emitRoot(node.pending)
        b.add('}')
      }

      if (node.resolved)
        this.emitAwaitBranch('ready', node.resolved, 'KayAwaited(kayAwaited)')

      if (node.rejected)
        this.emitAwaitBranch('failed', node.rejected, '(void 0 as unknown)')

      b.add(' /> })()}')
    })
  }

  private emitTry(node: TryNode) {
    const { b } = this

    b.wrap(node, () => {
      b.add('<KayTry block={')
      this.emitRoot(node.children)
      b.add('}')

      if (node.rejected)
        this.emitAwaitBranch('failed', node.rejected, '(void 0 as unknown)')

      b.add(' />')
    })
  }

  // Called with the block's value on the spot, which TypeScript reads as running inline; a block with no name is called with nothing.
  private emitAwaitBranch(prop: 'ready' | 'failed', branch: AwaitBranch, argument: string) {
    const { b } = this

    b.wrap(branch, () => {
      b.add(` ${prop}={((`)

      if (branch.alias)
        b.addSource(branch.alias)

      b.add(') => ')
      this.emitRoot(branch.children)
      b.add(`)(${branch.alias ? argument : ''})}`)
    })
  }

  private emitFor(node: ForNode) {
    const { b } = this

    if (this.options.check) {
      this.emitCheckedFor(node)

      return
    }

    if (this.options.staticLoops) {
      this.emitStaticFor(node)

      return
    }

    const tag = 'KayLoopFor'
    const positional = keyedByPosition(node, this.src)

    b.wrap(node, () => {
      b.add(`<${tag} each={`)

      b.addSource(node.each)

      b.add('} keyed={')

      if (positional)
        b.add('false')
      else if (node.key)
        b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')
      // Rows keyed by the item's `id` or the item itself, which any item has.
      else
        b.add('() => 0')

      b.add('}')

      if (node.fallback) {
        b.add(' fallback={')
        this.emitRoot(node.fallback)
        b.add('}')
      }

      b.add('>{(')
      this.sites.rows.add(b.code.length)
      b.addSource(node.item)

      if (node.index) {
        b.add(', ')

        if (!positional)
          this.sites.rows.add(b.code.length)

        b.addSource(node.index)
      }

      b.add(') => ')

      // A positional key reads the index, so the type check sees it read, and hover and rename reach the key's name.
      if (positional && this.options.check) {
        b.add('(void (').addSource(node.key).add('), ')
        this.emitRoot(node.children)
        b.add(')')
      }
      else {
        this.emitRoot(node.children)
      }

      b.add(`}</${tag}>`)
    })
  }

  // The type checker reads the loop's list once, and its block as a call on the spot with a row of that list, which TypeScript runs inline, so a property path an enclosing block narrowed stays narrowed inside it, as a callback would drop.
  private emitCheckedFor(node: ForNode) {
    const { b } = this
    const staticLoop = this.options.staticLoops === true
    const positional = keyedByPosition(node, this.src)

    b.wrap(node, () => {
      b.add('{(() => { const kayEach = (')

      b.addSource(node.each)

      b.add('); return ')

      if (staticLoop) {
        b.add(`${helperName('staticFor')}(kayEach, `)
      }
      else {
        b.add(`<KayLoopFor each={kayEach} keyed={`)

        if (positional)
          b.add('false')
        else if (node.key)
          b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')
        else
          b.add('() => 0')

        b.add('}')

        if (node.fallback) {
          b.add(' fallback={')
          this.emitRoot(node.fallback)
          b.add('}')
        }

        b.add('>{')
      }

      b.add('((')

      if (!staticLoop)
        this.sites.rows.add(b.code.length)

      b.addSource(node.item)

      if (node.index) {
        b.add(', ')

        if (!staticLoop && !positional)
          this.sites.rows.add(b.code.length)

        b.addSource(node.index)
      }

      b.add(') => ')

      // A key the loop does not match rows by is still read, so the type check sees it, and hover and rename reach the key's name.
      if (node.key && (staticLoop || positional)) {
        b.add('(void (').addSource(node.key).add('), ')
        this.emitRoot(node.children)
        b.add(')')
      }
      else {
        this.emitRoot(node.children)
      }

      b.add(node.index ? ')(KayRow(kayEach), 0)' : ')(KayRow(kayEach))')

      if (staticLoop) {
        if (node.fallback) {
          b.add(', ')
          this.emitRoot(node.fallback)
        }

        b.add(')')
      }
      else {
        b.add('}</KayLoopFor>')
      }

      b.add(' })()}')
    })
  }

  // Nothing here updates, so the loop's callback gets the item and the index themselves rather than `For`'s accessors.
  private emitStaticFor(node: ForNode) {
    const { b } = this

    b.wrap(node, () => {
      b.add('{KayStaticFor(').addSource(node.each).add(', (')
      b.addSource(node.item)

      if (node.index)
        b.add(', ').addSource(node.index)

      b.add(`) => `)
      this.emitRoot(node.children)

      if (node.fallback) {
        b.add(', () => ')
        this.emitRoot(node.fallback)
      }

      b.add(')}')
    })
  }

  private emitElement(element: ElementNode) {
    const { b } = this

    if (isSlot(element)) {
      b.wrap(element, () => {
        b.add('{')
        slotValue(b, element)

        if (element.children.length > 0) {
          b.add(' ?? ')
          this.emitRoot(element.children)
        }

        b.add('}')
      })

      return
    }

    b.wrap(element, () => {
      b.add('<')

      const named = element.tag.end > element.tag.start
      const dynamic = named ? b.addTag(element.tag) : false

      if (!named)
        b.add(element.name)

      this.emitAttributes(element)
      const slots = element.children.filter((child): child is SlotNode => child.kind === 'slot')
      const children = element.children.filter(child => child.kind !== 'slot')

      for (const slot of slots) {
        if (!element.component)
          continue

        // `@row(todo)` passes a function the component calls per item, its parameters typed from the prop.
        if (slot.params && this.options.check && this.options.sendsIslandProps) {
          b.add(' ')
          this.emitFunctionPropCheck(element, slot.name)
        }

        b.add(' ').addSource(slot.name).add('={')

        // One plain name is written bare, so a rule about the parentheses around it, which kay would otherwise be the one to write, has none to report.
        if (slot.params && PLAIN_PARAMETER.test(this.src.slice(slot.params.start, slot.params.end)))
          b.addSource(slot.params).add(' => ')
        else if (slot.params)
          b.add('(').addSource(slot.params).add(') => ')

        this.emitRoot(slot.children)
        b.add('}')
      }

      if (children.length === 0) {
        b.add(' />')

        return
      }

      b.add('>')
      this.emitChildren(children)
      b.add('</')

      // The closing tag reads the name the way the opening one did: a prop, a loop item or a server value may be the component.
      if (dynamic)
        b.add(DYNAMIC_TAG)
      else if (named)
        b.addSource(element.tag)
      else
        b.add(element.name)

      b.add('>')
    })
  }

  private emitAttributes(element: ElementNode) {
    const serverIsland = serverIslandOf(element, this.src)
    const { b } = this

    if (element.id)
      b.add(' id="').addSource(element.id).add('"')

    const classAttributes = element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'class')

    // A spread may carry a `class` of its own, which merges in too, so the class goes after every attribute and spread.
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')
    const merged = spreads && (element.classes.length > 0 || classAttributes.length > 0)

    if (element.classes.length > 0 && !spreads)
      this.emitShorthandClass(element, classAttributes[0])

    const part = partAttribute(element, this.src)

    for (const attribute of element.attributes) {
      if ((element.classes.length > 0 || merged) && attribute === classAttributes[0])
        continue

      // Not a prop of the element or the component: it names a part, whose class the component's own `class` type takes.
      if (attribute === part)
        continue

      if (attribute === serverIsland?.attribute)
        continue

      // Not a prop: what it reads is checked on its own.
      if (attribute === serverIsland?.noscript) {
        if (attribute.kind === 'expression')
          b.add(' {...(void (').addSource(attribute.expression).add('), {})}')

        continue
      }

      b.add(' ')

      if (!this.emitFormAttribute(element, attribute))
        this.emitAttribute(element, attribute)
    }

    if (merged)
      this.emitMergedClass(element, classAttributes[0])

    if (actionOf(element, this.src)) {
      const named = (name: string) => element.attributes.some(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === name)

      if (!named('method'))
        b.add(' method="post"')

      // Multipart whatever the schema, so file inputs post too; Elysia parses either encoding alike.
      if (!named('enctype'))
        b.add(' enctype="multipart/form-data"')
    }
  }

  // `form(action={add})` posts to the action's URL, and each field `name` inside it must be a key of the action's input.
  private emitFormAttribute(element: ElementNode, attribute: Attribute): boolean {
    const { b } = this

    if (attribute.kind === 'expression' && attribute === actionOf(element, this.src)) {
      this.attributeName(attribute).add(`={${helperName('formAction')}((`).addSource(attribute.expression).add('))}')

      return true
    }

    if (attribute.kind === 'spread' || element.component)
      return false

    const name = this.text(attribute.name)
    const target = this.facts.forms.get(element)

    if (name === FIELD_ATTRIBUTE ? !FIELD_ELEMENTS.has(element.name) : name !== 'name' || !FORM_FIELDS.has(element.name))
      return false

    // `field` writes `name`, and the constraints of the action's schema, which only a form posting to one has.
    if (name === FIELD_ATTRIBUTE) {
      const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === 'name')

      if (attribute.kind !== 'static' || named) {
        b.add('{...{}}')

        return true
      }
    }

    if (!this.options.check || !target || attribute.kind !== 'static') {
      if (name !== FIELD_ATTRIBUTE)
        return false

      b.wrap(attribute.name, () => b.add('name')).add(`=${JSON.stringify(attribute.kind === 'static' ? attribute.text : '')}`)

      return true
    }

    b.wrap(attribute.name, () => b.add('name')).add('={KayField((').addSource(target).add('), ')
    b.wrap(attribute.value, () => b.add(JSON.stringify(attribute.text)))
    b.add(')}')

    return true
  }

  private emitShorthandClass(element: ElementNode, attribute: NamedAttribute | undefined) {
    const { b } = this
    const shorthand = element.classes.map(span => this.text(span)).join(' ')
    const source = { start: element.classes[0]!.start, end: element.classes.at(-1)!.end }

    b.add(' ')

    if (!attribute) {
      b.wrap(source, () => b.add(`class=${quoteAttribute(shorthand)}`))

      return
    }

    if (attribute.kind === 'static') {
      b.wrap(source, () => b.add(`class=${quoteAttribute(`${shorthand} ${attribute.text}`)}`))

      return
    }

    if (attribute.kind === 'expression') {
      const [open, close] = element.component ? [`${helperName('componentClass')}([`, '])'] : ['[', ']']

      this.attributeName(attribute).add(`={${open}${JSON.stringify(shorthand)}, (`).addSource(attribute.expression).add(`)${close}}`)
    }
  }

  // The shorthand, the `class` attribute and the `class` each spread brings, in the order they were written.
  private emitMergedClass(element: ElementNode, classAttribute: NamedAttribute | undefined) {
    const { b } = this
    const shorthand = element.classes.length > 0 ? { start: element.classes[0]!.start, end: element.classes.at(-1)!.end } : undefined

    b.add(' ')
    b.wrap(classAttribute && (classAttribute.kind === 'expression' || !shorthand) ? classAttribute.name : shorthand!, () => b.add('class'))
    b.add(element.component ? `={${helperName('componentClass')}([` : '={[')

    if (shorthand)
      b.add(JSON.stringify(element.classes.map(span => this.text(span)).join(' ')))

    let separator = shorthand ? ', ' : ''

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread') {
        b.add(`${separator}((`).addSource(attribute.expression).add(') as unknown as { class?: string }).class')
        separator = ', '

        continue
      }

      if (attribute !== classAttribute)
        continue

      if (attribute.kind === 'static')
        b.add(`${separator}${JSON.stringify(attribute.text)}`)
      else if (attribute.kind === 'expression')
        b.add(`${separator}(`).addSource(attribute.expression).add(')')

      separator = ', '
    }

    b.add(element.component ? '])}' : ']}')
  }

  private emitAttribute(element: ElementNode, attribute: Attribute) {
    const { b } = this

    if (this.options.check && this.emitCheckedAttribute(element, attribute))
      return

    switch (attribute.kind) {
      case 'spread':
        b.add('{...').addSource(attribute.expression).add('}')

        return
      case 'boolean':
        this.attributeName(attribute)

        return
      case 'static': {
        this.attributeName(attribute).add('=')
        const quoted = quoteAttribute(attribute.text)

        if (quoted === `"${attribute.text}"`)
          b.add('"').addSource(attribute.value).add('"')
        else
          b.wrap(attribute.value, () => b.add(quoted))

        return
      }
      case 'expression': {
        const name = this.text(attribute.name)

        if (name.startsWith('bind:')) {
          this.emitBind(element, attribute, name.slice(5))

          return
        }

        // Read at each event rather than once, as the browser build does, so a handler held by a prop, a signal or a loop item stays current.
        if (!element.component && !this.options.check && EVENT_HANDLER.test(name) && !isFunctionAt(this.src, attribute.expression, this.facts.functions)) {
          this.attributeName(attribute).add('={(kayEvent) => (').addSource(attribute.expression).add(')?.(kayEvent)}')

          return
        }

        this.attributeName(attribute).add('={').addSource(attribute.expression).add('}')
      }
    }
  }

  // The text of an attribute written as a quoted string.
  private staticAttribute(element: ElementNode, name: string): string | undefined {
    for (const attribute of element.attributes) {
      if (attribute.kind === 'static' && this.text(attribute.name) === name)
        return attribute.text
    }

    return undefined
  }

  // Check-only wrappers: a site link must match a page, markup must be made safe or written out, and a static parent passes an island serializable props only.
  private emitCheckedAttribute(element: ElementNode, attribute: Attribute): boolean {
    const { b } = this

    if (attribute.kind === 'boolean')
      return false

    // Spread props reach an island serialized as the others do, so the object is checked as one prop would be.
    if (attribute.kind === 'spread') {
      if (!element.component || !this.options.sendsIslandProps)
        return false

      b.add('{...KayProp(').addSource(element.tag).add(')((').addSource(attribute.expression).add('))}')

      return true
    }

    const name = this.text(attribute.name)

    if (!element.component && ((LINK_ELEMENTS.has(element.name) && name === 'href') || (attribute.kind === 'static' && WRITTEN_URLS.get(element.name) === name && !this.servedOtherwise(element)))) {
      this.attributeName(attribute).add('={KayHref(')

      if (attribute.kind === 'static')
        b.wrap(attribute.value, () => b.add(JSON.stringify(attribute.text)))
      else
        b.add('(').addSource(attribute.expression).add(')')

      b.add(')}')

      return true
    }

    if (!element.component && attribute.kind === 'expression' && MARKUP_ATTRIBUTES.has(name)) {
      this.attributeName(attribute).add('={KayHtml((').addSource(attribute.expression).add('))}')

      return true
    }

    if (!element.component || !this.options.sendsIslandProps || attribute.kind !== 'expression' || name.startsWith('bind:'))
      return false

    // A function never reaches an island, and left unwrapped it takes its parameter types from a generic component's other props.
    if (isFunctionAt(this.src, attribute.expression, this.facts.functions)) {
      this.emitFunctionPropCheck(element, attribute.name)
      b.add(' ').addSource(attribute.name).add('={').addSource(attribute.expression).add('}')

      return true
    }

    const { start, end } = attribute.expression
    const sent = sentParts(this.src.slice(start, end)) ?? { parts: [{ start: 0, end: end - start }], functions: false }
    let at = start

    if (sent.functions) {
      this.emitFunctionPropCheck(element, attribute.name)
      b.add(' ')
    }

    this.attributeName(attribute).add('={')

    for (const part of sent.parts) {
      b.addSource({ start: at, end: start + part.start }).add('KayProp(').addSource(element.tag).add(')((').addSource({ start: start + part.start, end: start + part.end }).add('))')
      at = start + part.end
    }

    b.addSource({ start: at, end }).add('}')

    return true
  }

  // A feed or a translation, served by what kay check does not list as pages, or a form posting to a route that may take its method only.
  private servedOtherwise(element: ElementNode): boolean {
    const value = (name: string) => element.attributes.find(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === name)
    const rel = value('rel')
    const method = value('method')

    if (element.name === 'form')
      return method !== undefined && (method.kind !== 'static' || method.text.toLowerCase() !== 'get')

    return element.name === 'link' && rel?.kind === 'static' && rel.text.split(WHITESPACE).includes('alternate')
  }

  // The name of an attribute as written, which a bare `{name}` shares with its value, so the rewrites of that value leave it alone.
  private attributeName(attribute: NamedAttribute): CodeBuilder {
    if (attribute.kind === 'expression' && attribute.shorthand)
      return this.b.wrap(attribute.name, () => this.b.add(this.text(attribute.name)))

    return this.b.addSource(attribute.name)
  }

  // Reports a function passed to an island, `0` standing for the prop.
  private emitFunctionPropCheck(element: ElementNode, name: Span) {
    this.b.add('{...KayFunctionProp(').addSource(element.tag).add(')(').wrap(name, () => this.b.add('0')).add(')}')
  }

  // `bind:value={name}` reads the signal and writes it back from the matching input event.
  private emitBind(element: ElementNode, attribute: Extract<Attribute, { kind: 'expression' }>, property: string) {
    const { b } = this

    if (bindProblem(element, property))
      return

    const inputType = this.staticAttribute(element, 'type') ?? 'text'
    const event = bindEvent(element, property)

    b.wrap(attribute.name, () => b.add(property))
    b.add('={(').addSource(attribute.expression).add(`)()} ${event}={(kayEvent) => `)
    addBindWrite(b, attribute.expression, bindRead(property, inputType))
    b.add('}')
  }

  private emitText(node: TextNode) {
    const { b } = this

    for (const part of node.parts) {
      if (part.kind === 'element') {
        this.emitElement(part)

        continue
      }

      if (part.kind === 'expression') {
        b.add('{').addSource(part.expression).add('}')

        continue
      }

      const escaped = part.text.replace(JSX_TEXT_ESCAPES, text => `{${JSON.stringify(text)}}`)

      if (escaped === this.text(part))
        b.addSource(part)
      else
        b.wrap(part, () => b.add(escaped))
    }
  }

  private withoutSlots(nodes: Node[]): Node[] {
    return nodes.filter(node => node.kind !== 'slot')
  }

  private text(span: Span): string {
    return this.src.slice(span.start, span.end)
  }
}

// JSX attribute strings have no escapes, so pick a quote the value does not contain, or fall back to an expression.
function quoteAttribute(value: string): string {
  if (!value.includes('"'))
    return `"${value}"`

  return !value.includes('\'') ? `'${value}'` : `{${JSON.stringify(value)}}`
}
