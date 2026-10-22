import type { ClassTable } from '../runtime/class-table'
import type { AwaitNode, ElementNode, ElseBlock, ErrorMessages, ForNode, IfNode, MatchNode, Node, Span, TemplateFacts, TryNode } from './ast'
import type { Declaration, DynamicItem } from './items'
import type { CodeBuilder } from './mapping'
import type { PlannedAttribute } from './markup'
import { mayLeaveSite } from '../runtime/outside'
import { keyedByPosition, marksServerIsland, modifiersOf } from './ast'
import { decodeEntities, isFunctionAt } from './expression'
import { childItems, constDeclaration, errorParagraphArguments, isDeclaration, slotValue, soleDynamic } from './items'
import { addBindWrite, addHandler, addStyleArguments, bindRead, END_MARKER, escapeStaticAttribute, escapeText, GROUP_HAS, groupValue, helperName, RAW_ELEMENTS, START_MARKER, TemplateWriter, VOID_ELEMENTS } from './markup'
import { SUBJECT } from './names'
import { bindEvent } from './validate'

// The `kay/dom` helpers browser output calls, each imported under a `Kay` name; `image` and `pendingCall` are in modules of their own, as their runtimes weigh on a page with no image or no pending block.
const DOM_HELPERS = ['append', 'attempt', 'attribute', 'awaited', 'branches', 'choose', 'close', 'component', 'componentClass', 'dynamic', 'effect', 'errorParagraph', 'fragment', 'holdSubmits', 'insert', 'listen', 'listenSubmit', 'loop', 'markers', 'memo', 'merge', 'omit', 'outside', 'partClass', 'partHanded', 'partsClass', 'property', 'ref', 'rowKey', 'setClass', 'setStyle', 'spread', 'spreadAttributes', 'template', 'text', 'transition', 'untrack']
const TRANSITION_PART = 'transition:'

export function domHelperImport(): string {
  return `import { ${DOM_HELPERS.map(helper => `${helper} as ${helperName(helper)}`).join(', ')} } from 'kay/dom'\nimport { image as ${helperName('image')} } from 'kay/dom-image'\nimport { pendingCall as ${helperName('pendingCall')} } from 'kay/pending'\n`
}

// A node of a template, so the code can reach the ones it binds: through `firstChild` and `nextSibling`, and past a dynamic part through its end marker.
interface TemplateNode {
  kind: 'element' | 'text' | 'start' | 'end'
  parent?: TemplateNode | undefined
  previous?: TemplateNode | undefined
  last?: TemplateNode | undefined
  variable?: string | undefined
}

// What the code does with a template's nodes once it holds the root, in document order, an element's own bindings after its content's.
type Binding = (variable: (node: TemplateNode) => string) => void

// A template as code building its DOM in the browser, or claiming the server's markup of it when an island hydrates.
export class DomTemplate extends TemplateWriter {
  protected override readonly lazySlots = true
  private readonly templates: string[] = []
  private counter = 0
  // How many blocks of template `const`s the binding being emitted sits in: a node first reached there is declared with `var`, so the bindings after the block reach it too.
  private constBlocks = 0
  // The names the `try` blocks being written give their `catch`, which an `await` without a `catch` inside falls back to: the runtime hands the function, or one rendering nothing, to the content of the `try`.
  private readonly catches: string[] = []

  // `errors`: what a refused form's fields are described by.
  // `located`, in development: the source position each element carries for `kay dev`'s inspector.
  constructor(b: CodeBuilder, src: string, facts: TemplateFacts, private readonly errors?: ErrorMessages, private readonly located?: (element: ElementNode) => string | undefined, classTable?: ClassTable) {
    super(b, src, facts)
    this.classTable = classTable
  }

  // A block: one element, or a fragment of its items, or `null` when empty.
  block(nodes: Node[]): void {
    const items = childItems(nodes)
    const [only] = items

    if (!only)
      this.b.add('null')
    else if (items.length === 1 && only.kind === 'element')
      this.element(only.node)
    else
      this.fragment(nodes)
  }

  // The module-level templates the code clones, declared after the components that use them.
  declarations(): string {
    return this.templates.map((html, index) => `const KayT${index} = KayTemplate(${JSON.stringify(html)})\n`).join('')
  }

  private fragment(nodes: Node[]): void {
    const { b } = this
    const parent = `KayP${this.counter++}`

    b.add(`KayFragment((${parent}) => { `)
    let blocks = 0

    for (const item of childItems(nodes)) {
      if (isDeclaration(item)) {
        b.add('{ ')
        this.declaration(item)
        blocks++
      }
      else if (item.kind === 'text') {
        b.add(`KayText(${parent}, ${JSON.stringify(decodeEntities(item.text))}); `)
      }
      else if (item.kind === 'element') {
        b.add(`KayAppend(${parent}, `)
        this.element(item.node)
        b.add('); ')
      }
      else {
        b.add(`{ const [KayS, KayE] = KayMarkers(${parent}); `)
        this.dynamic(item, 'null', 'KayS', 'KayE')
        b.add(' } ')
      }
    }

    b.add(`${'} '.repeat(blocks)}})`)
  }

  // A dynamic part rendered into an element's content, or between two markers.
  private dynamic(item: DynamicItem, element: string, start: string, end: string): void {
    const { b } = this
    const at = `${element}, ${start}, ${end}`

    switch (item.kind) {
      case 'expression':
        b.add(`KayInsert(${at}, () => (`).addSource(item.node.expression).add('));')

        break
      case 'component':
        b.wrap(item.node, () => {
          b.add(`KayInsert(${at}, () => `)
          this.component(item.node)
          b.add(', false);')
        })

        break
      case 'slot':
        b.wrap(item.node, () => {
          b.add(`KayInsert(${at}, () => `)
          slotValue(b, item.node)

          if (item.node.children.length > 0) {
            b.add(' ?? (')
            this.childrenValue(item.node.children)
            b.add(')')
          }

          b.add(');')
        })

        break
      case 'if':
        b.wrap(item.node, () => this.if(item.node, at))

        break
      case 'match':
        b.wrap(item.node, () => this.match(item.node, at))

        break
      case 'for':
        b.wrap(item.node, () => this.for(item.node, at))

        break
      case 'await':
        b.wrap(item.node, () => this.await(item.node, at))

        break
      case 'try':
        b.wrap(item.node, () => this.try(item.node, at))

        break
      case 'error':
        if (this.facts.forms.has(item.node)) {
          const target = this.facts.forms.get(item.node)!

          b.wrap(item.node, () => {
            b.add(`KayInsert(${at}, () => ${helperName('errorParagraph')}(KayFormError((`).addSource(target).add(`), ${JSON.stringify(item.node.name)}), ${errorParagraphArguments(item.node, this.src, this.errors?.lines.get(item.node))}));`)
          })
        }

        break
    }
  }

  private declaration(item: Declaration): void {
    if (item.kind === 'snippet')
      this.snippetDeclaration(item.node)
    else
      this.b.wrap(item.node, () => constDeclaration(this.b, item.node, this.src, helperName('memo')))
  }

  private if(node: IfNode, at: string): void {
    const { b } = this

    // A chain naming no value needs no memo of it.
    b.add(`${node.branches.some(branch => branch.alias) ? 'KayBranches' : 'KayChoose'}(${at}, [`)

    for (const branch of node.branches) {
      b.wrap(branch, () => {
        b.add('[() => (').addSource(branch.test).add('), (')

        if (branch.alias)
          b.addSource(branch.alias)

        b.add(') => ')
        this.block(branch.children)
        b.add('], ')
      })
    }

    this.else(node.fallback)
    b.add(']);')
  }

  // A `match` reads its subject once, which each case compares with its values.
  private match(node: MatchNode, at: string): void {
    const { b } = this

    b.add(`{ const ${SUBJECT} = ${helperName('memo')}(() => (`).addSource(node.subject).add(`)); KayChoose(${at}, [`)

    for (const branch of node.cases) {
      b.wrap(branch, () => {
        b.add('[() => ')

        for (const [index, value] of branch.values.entries())
          b.add(index === 0 ? `${SUBJECT}() === (` : ` || ${SUBJECT}() === (`).addSource(value).add(')')

        b.add(', () => ')
        this.block(branch.children)
        b.add('], ')
      })
    }

    this.else(node.fallback)
    b.add(']); }')
  }

  private else(block: ElseBlock | undefined): void {
    if (!block)
      return

    this.b.wrap(block, () => {
      this.b.add('[null, () => ')
      this.block(block.children)
      this.b.add('], ')
    })
  }

  private for(node: ForNode, at: string): void {
    const { b } = this
    // A key naming the index means rows are matched by position: `for row, i of rows key={i}`.
    const positional = keyedByPosition(node, this.src)

    b.add(`KayLoop(${at}, () => (`).addSource(node.each).add('), ')

    if (positional)
      b.add('false')
    else if (node.key)
      b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')
    else
      b.add(helperName('rowKey'))

    b.add(', (').addSource(node.item)

    if (node.index)
      b.add(', ').addSource(node.index)

    b.add(') => ')
    this.block(node.children)

    if (node.fallback) {
      b.add(', () => ')
      this.block(node.fallback)
    }

    b.add(');')
  }

  private try(node: TryNode, at: string): void {
    const { b } = this
    const branch = node.rejected

    const name = `KayCatch${this.catches.length}`

    b.add(`KayAttempt(${at}, (${name}) => `)
    this.catches.push(name)
    this.block(node.children)
    this.catches.pop()
    b.add(', ')

    if (branch) {
      b.wrap(branch, () => {
        b.add('(')

        if (branch.alias)
          b.addSource(branch.alias)

        b.add(') => ')
        this.block(branch.children)
      })
    }
    else {
      b.add('undefined')
    }

    b.add(');')
  }

  private await(node: AwaitNode, at: string): void {
    const { b } = this

    b.add(`KayAwaited(${at}, () => (`).addSource(node.value).add('), ')

    if (node.pending.length > 0) {
      b.add('() => ')
      this.block(node.pending)
    }
    else {
      b.add('undefined')
    }

    for (const branch of [node.resolved, node.rejected]) {
      b.add(', ')

      if (!branch) {
        b.add(branch === node.resolved ? '() => null' : 'undefined')

        continue
      }

      b.wrap(branch, () => {
        b.add('(')

        if (branch.alias)
          b.addSource(branch.alias)

        b.add(') => ')
        this.block(branch.children)
      })
    }

    // With no `catch` of its own, a rejection renders the enclosing `try`'s, or nothing when that has none.
    if (!node.rejected && this.catches.length > 0)
      b.add(`, ${this.catches.at(-1)!}`)

    b.add(');')
  }

  // An element built from a template, its dynamic attributes, handlers and parts bound once the root is in hand.
  private element(element: ElementNode): void {
    const { b } = this
    const bindings: Binding[] = []
    const root: TemplateNode = { kind: 'element' }
    const html = this.templateOf(element, root, bindings)
    const index = this.templates.push(html) - 1

    if (bindings.length === 0) {
      b.add(`KayT${index}()`)

      return
    }

    const prefix = `KayN${this.counter++}_`
    let next = 0

    root.variable = `${prefix}${next++}`
    b.add(`(() => { const ${root.variable} = KayT${index}(); `)

    const variable = (node: TemplateNode): string => {
      if (node.variable !== undefined)
        return node.variable

      let access: string

      if (node.kind === 'end')
        access = `KayClose(${variable(node.previous!)})`
      else if (node.previous)
        access = `${variable(node.previous)}.nextSibling`
      else
        access = `${variable(node.parent!)}.firstChild`

      node.variable = `${prefix}${next++}`
      b.add(`${this.constBlocks > 0 ? 'var' : 'const'} ${node.variable} = ${access}; `)

      return node.variable
    }

    for (const binding of bindings) {
      binding(variable)
      b.add(' ')
    }

    b.add(`return ${root.variable} })()`)
  }

  private child(parent: TemplateNode, kind: TemplateNode['kind']): TemplateNode {
    const node: TemplateNode = { kind, parent, previous: parent.last }

    parent.last = node

    return node
  }

  // The element's markup for the template, with what the code binds collected along the way.
  private templateOf(element: ElementNode, node: TemplateNode, bindings: Binding[]): string {
    const { b } = this
    const name = element.name
    const spreads = element.attributes.some(attribute => attribute.kind === 'spread')
    const children = element.children.filter(child => child.kind !== 'slot')
    const own: Binding[] = []
    let html = `<${name}${element.fixed ?? ''}`
    let content: string | undefined
    let contentBinding: Binding | undefined
    let selected: Span | undefined

    if (spreads) {
      own.push(variable => this.spreadBinding(element, variable(node), children.length === 0))
    }
    else {
      const plan = this.plan(element, this.errors)
      const { target, field, action, described } = plan
      const followed = element.pendingOf && this.facts.forms.get(element.pendingOf)

      // An island's block shows while a call of its form's action is in flight, however the handler made it.
      if (followed)
        own.push(variable => b.add(`KayEffect(() => ${helperName('pendingCall')}(${variable(node)}, (`).addSource(followed).add(')));'))

      if (plan.id !== undefined)
        html += ` id="${escapeStaticAttribute(plan.id)}"`

      if (plan.classes?.expression || plan.classes?.parts) {
        const classes = plan.classes

        own.push((variable) => {
          b.add(`KayEffect(() => KaySetClass(${variable(node)}, `)
          this.classList(classes)
          b.add('));')
        })
      }
      else if (plan.classes) {
        html += ` class="${escapeStaticAttribute(plan.classes.text)}"`
      }

      for (const attribute of plan.attributes) {
        switch (attribute.kind) {
          case 'bind':
          case 'behaviour': {
            const binding = this.behaviour(element, attribute, node)

            if (binding)
              own.push(binding)

            break
          }
          case 'boolean':
            html += ` ${attribute.name}`

            break
          case 'text':
            html += attribute.bare ? ` ${attribute.name}` : ` ${attribute.name}="${escapeStaticAttribute(attribute.text)}"`

            if (attribute.name === 'href' && this.leavingLink(element) && mayLeaveSite(attribute.text))
              own.push(variable => b.add(`KayOutside(${variable(node)}, ${JSON.stringify(attribute.text)}${this.named(element, 'rel') ? ', true' : ''});`))

            break
          case 'rooted':
            own.push(variable => b.add(`KayAttribute(${variable(node)}, ${JSON.stringify(attribute.name)}, ${JSON.stringify(attribute.text)}${this.writtenLink(element, attribute.name) ? ', true' : ''});`))

            if (attribute.name === 'href' && this.leavingLink(element) && mayLeaveSite(attribute.text))
              own.push(variable => b.add(`KayOutside(${variable(node)}, ${JSON.stringify(attribute.text)}${this.named(element, 'rel') ? ', true' : ''});`))

            break
          case 'class':
            own.push(variable => b.add(`KayEffect(() => KaySetClass(${variable(node)}, (`).addSource(attribute.expression).add(')));'))

            break
          case 'style':
            own.push((variable) => {
              b.add(`KayEffect(() => KaySetStyle(${variable(node)}, `)
              addStyleArguments(b, attribute)
              b.add('));')
            })

            break
          case 'image':
            own.push((variable) => {
              b.add(`KayEffect(() => KayImage(${variable(node)}, (`).addSource(attribute.expression).add(`), ${attribute.sized}`)
              this.sizesArgument(plan.sizes)
              b.add('));')
            })

            break
          // Set once the options are in, unless a `bind:value` after it takes over, as the server reads the last of them.
          case 'selected':
            selected = plan.selected!.bound ? undefined : attribute.expression

            break
          case 'value':
            own.push((variable) => {
              b.add(`KayEffect(() => KayProperty(${variable(node)}, ${JSON.stringify(attribute.name)}, `)

              if (attribute.action)
                b.add('KayFormAction((').addSource(attribute.expression).add('))')
              else if (attribute.name === 'href' && this.leavingLink(element))
                b.add(`KayOutside(${variable(node)}, (`).addSource(attribute.expression).add(`)${this.named(element, 'rel') ? ', true' : ''})`)
              else
                b.add('(').addSource(attribute.expression).add(')')

              b.add(`${this.writtenLink(element, attribute.name) ? ', true' : ''}));`)
            })

            break
        }
      }

      content = plan.staticContent

      // A bound textarea's value and select's value are set by the binding.
      if (plan.content && !plan.content.bound) {
        const { property, expression } = plan.content

        contentBinding = variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, ${JSON.stringify(property)}, (`).addSource(expression).add(')));')
      }

      if (action) {
        if (action.method)
          html += ' method="post"'

        if (action.enctype)
          html += ' enctype="multipart/form-data"'

        if (described)
          own.push(variable => b.add(`KayEffect(() => KayFormDescribed(${variable(node)}, (`).addSource(action.expression).add(`), "", ${JSON.stringify(described.id)}));`))
      }

      if (field?.invalid && target) {
        own.push(variable => b.add(`KayEffect(() => KayFormMarked(${variable(node)}, (`).addSource(target).add(`), ${JSON.stringify(field.name)}));`))

        if (described)
          own.push(variable => b.add(`KayEffect(() => KayFormDescribed(${variable(node)}, (`).addSource(target).add(`), ${JSON.stringify(field.name)}, ${JSON.stringify(described.id)}));`))
      }

      // The template's own description stays as written, the effect adding and removing the message's id alone.
      if (described?.own !== undefined)
        html += ` aria-describedby="${escapeStaticAttribute(described.own)}"`
    }

    const located = this.located?.(element)

    if (located !== undefined)
      html += ` data-kay-src="${escapeStaticAttribute(located)}"`

    html += '>'

    if (VOID_ELEMENTS.has(name)) {
      bindings.push(...own)

      return html
    }

    if (children.length > 0) {
      const items = childItems(children)
      const raw = RAW_ELEMENTS.has(name)
      const sole = soleDynamic(items)
      let blocks = 0

      for (const item of items) {
        if (isDeclaration(item)) {
          blocks++
          bindings.push(() => {
            b.add('{ ')
            this.constBlocks++
            this.declaration(item)
          })
        }
        else if (item.kind === 'text') {
          this.child(node, 'text')
          html += raw ? item.text : escapeText(item.text)
        }
        else if (item.kind === 'element') {
          html += this.templateOf(item.node, this.child(node, 'element'), bindings)
        }
        else if (sole) {
          bindings.push(variable => this.dynamic(item, variable(node), 'null', 'null'))
        }
        else {
          const start = this.child(node, 'start')
          const end = this.child(node, 'end')

          html += START_MARKER + END_MARKER
          bindings.push(variable => this.dynamic(item, 'null', variable(start), variable(end)))
        }
      }

      if (blocks > 0) {
        bindings.push(() => {
          b.add('}'.repeat(blocks))
          this.constBlocks -= blocks
        })
      }
    }
    else if (content !== undefined) {
      html += content
    }
    else if (contentBinding) {
      own.push(contentBinding)
    }

    if (selected) {
      const value = selected

      own.push(variable => b.add(`KayEffect(() => KayProperty(${variable(node)}, "value", (`).addSource(value).add(')));'))
    }

    bindings.push(...own)

    return `${html}</${name}>`
  }

  // A handler, a ref, a binding or a transition: what only the browser attaches.
  private behaviour(element: ElementNode, planned: Extract<PlannedAttribute, { kind: 'bind' | 'behaviour' }>, node: TemplateNode): Binding | undefined {
    const { b } = this
    const { name } = planned

    if (planned.kind === 'bind')
      return variable => this.bind(element, planned.expression, planned.property, variable(node))

    const { attribute } = planned

    if (name === 'transition' || name.startsWith(TRANSITION_PART)) {
      const part = name === 'transition' ? 'name' : name.slice(TRANSITION_PART.length)

      return (variable) => {
        b.add(`KayTransition(${variable(node)}, ${JSON.stringify(part)}, `)

        if (attribute.kind === 'expression')
          b.add('(').addSource(attribute.expression).add(')')
        else
          b.add(JSON.stringify(attribute.kind === 'static' ? decodeEntities(attribute.text) : ''))

        b.add(');')
      }
    }

    if (attribute.kind !== 'expression')
      return undefined

    const expression = attribute.expression

    if (name === 'ref')
      return variable => b.add(`KayRef(${variable(node)}, (`).addSource(expression).add('));')

    if (!name.startsWith('on') || name.startsWith('on:'))
      return undefined

    // Read at each event rather than once, so a handler a prop, a signal or a loop item holds stays current.
    return (variable) => {
      // A `submit` handler is held while it answers a promise, which only an island listening to one loads.
      b.add(`${helperName(name.toLowerCase() === 'onsubmit' ? 'listenSubmit' : 'listen')}(${variable(node)}, ${JSON.stringify(name)}, `)

      addHandler(b, expression, modifiersOf(attribute, this.src), isFunctionAt(this.src, expression, this.facts.functions))

      b.add(');')
    }
  }

  // `bind:value={name}` reads the signal and writes it back from the matching input event.
  private bind(element: ElementNode, expression: Span, property: string, variable: string): void {
    const { b } = this
    const inputType = this.staticAttribute(element, 'type') ?? 'text'
    const event = bindEvent(element, property)

    if (property === 'group') {
      const value = groupValue(element, span => this.source(span))

      b.add(`KayEffect(() => KayProperty(${variable}, "checked", ${GROUP_HAS}((`).addSource(expression).add(')(), ')

      if ('text' in value)
        b.add(JSON.stringify(value.text))
      else
        b.add('(').addSource(value.expression).add(')')

      b.add('))); ')
    }
    else if (property === 'files') {
      // The signal holds what the person picked; emptying it clears the input, but not on the first run, when a file picked before hydration must stay.
      b.add(`{ let kayFresh = true; KayEffect(() => { const kayFiles = (`).addSource(expression).add(`)(); if (!kayFresh && !kayFiles?.length) ${variable}.value = ''; kayFresh = false }) } `)
    }
    else {
      b.add(`KayEffect(() => KayProperty(${variable}, ${JSON.stringify(property)}, (`).addSource(expression).add(')())); ')
    }

    b.add(`KayListen(${variable}, ${JSON.stringify(event)}, (kayEvent) => `)
    addBindWrite(b, expression, bindRead(property, inputType))
    b.add(');')
  }

  private spreadBinding(element: ElementNode, variable: string, content: boolean): void {
    const { b } = this

    if (element.name === 'form')
      b.add(`${helperName('holdSubmits')}(); `)

    const link = element.name === 'a'

    b.add(`KaySpread(${variable}, () => [`)
    this.leadingImageDefaults(element)
    this.sources(element, false)
    this.formDefaults(element)

    b.add(`]${content || link ? `, ${content}` : ''}${link ? ', true' : ''});`)
  }

  private component(element: ElementNode): void {
    const { b } = this
    const dynamic = b.isDynamicTag(element.tag)
    // A tag read at runtime may name a form, whose `submit` handler, written or spread, is held as a written form's is.
    const holds = dynamic && element.attributes.some(attribute => attribute.kind === 'spread' || this.source(attribute.name).toLowerCase() === 'onsubmit')

    if (holds)
      b.add(`(${helperName('holdSubmits')}(), `)

    b.add(dynamic ? 'KayDynamic(' : 'KayComponent(').addSource(element.tag).add(', ')

    this.componentProps(element, true)
    b.add(holds ? '))' : ')')
  }

  protected rendered(nodes: Node[]): void {
    this.block(nodes)
  }

  // Inside an island a server island is a component as any other.
  protected skips(element: ElementNode, name: string): boolean {
    return marksServerIsland(element, name, this.src)
  }

  private staticAttribute(element: ElementNode, name: string): string | undefined {
    for (const attribute of element.attributes) {
      if (attribute.kind === 'static' && this.source(attribute.name) === name)
        return attribute.text
    }

    return undefined
  }

  // A link that may leave the site, and so opens in a new tab unless it sets its own `target`.
  private leavingLink(element: ElementNode): boolean {
    return element.name === 'a' && !this.named(element, 'target')
  }

  // A link's href kept as written, the link carrying `hreflang`, where any other goes to the page's locale's copy.
  private writtenLink(element: ElementNode, attribute: string): boolean {
    return element.name === 'a' && attribute === 'href' && this.named(element, 'hreflang')
  }
}
