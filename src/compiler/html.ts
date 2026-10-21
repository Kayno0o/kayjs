import type { AwaitNode, ElementNode, ElseBlock, ErrorMessages, ErrorNode, ForNode, IfNode, MatchNode, NamedAttribute, Node, Span, TemplateFacts, TryNode } from './ast'
import type { DynamicItem, Item } from './items'
import type { CodeBuilder } from './mapping'
import { mayLeaveSite } from '../runtime/outside'
import { actionOf, FIELD_ELEMENTS, keyedByPosition, marksServerIsland, sectionOf, serverIslandOf, UNCHECKED_TYPES, UNREQUIRABLE_TYPES } from './ast'
import { decodeEntities } from './expression'
import { childItems, constDeclaration, errorParagraphArguments, isDeclaration, slotValue, soleDynamic } from './items'
import { BEHAVIOUR, describedValue, END_MARKER, escapeStaticAttribute, escapeText, fromRoot, helperName, RAW_ELEMENTS, START_MARKER, TemplateWriter, VOID_ELEMENTS } from './markup'
import { SUBJECT } from './names'

// The attribute an image's `src` or a select's `selected` value is written as.
const WRITTEN_AS = { image: 'src', selected: 'value' } as const
// The `kay/html` helpers static server output calls, each imported under a `Kay` name.
const HTML_HELPERS = ['attempt', 'attribute', 'child', 'className', 'component', 'componentClass', 'currentPage', 'dynamic', 'element', 'errorParagraph', 'fieldDescribed', 'formConstraints', 'head', 'html', 'imageAttributes', 'linkHref', 'localHref', 'loop', 'memo', 'merge', 'nonEmptyAttribute', 'omit', 'outsideLink', 'raw', 'refillOptions', 'selectOptions', 'serverIsland', 'show', 'spreadAttributes', 'style', 'untrack']

export function htmlHelperImport(): string {
  return `import { ${HTML_HELPERS.map(helper => `${helper} as ${helperName(helper)}`).join(', ')} } from 'kay/html'\n`
}

export interface HtmlOptions {
  // An island or a twin: dynamic parts carry markers for hydration.
  hydratable?: boolean | undefined
  // Loop rows read their item, and a keyed row its index, through functions, as the island build of the same template does.
  accessorLoops?: boolean | undefined
  // What a refused form's fields are described by.
  errors?: ErrorMessages | undefined
  // Development: the source position each element carries for `kay dev`'s inspector.
  located?: ((element: ElementNode) => string | undefined) | undefined
}

// Static parts gather into one string literal; each dynamic part is an expression of the markup it renders.
class Markup {
  private pending = ''
  private parts = 0

  constructor(private readonly b: CodeBuilder) {}

  text(text: string): void {
    this.pending += text
  }

  dynamic(emit: () => void): void {
    this.flush()
    this.separate()
    emit()
  }

  end(): void {
    this.flush()

    if (this.parts === 0)
      this.b.add('""')
  }

  private flush(): void {
    if (this.pending === '')
      return

    this.separate()
    this.b.add(JSON.stringify(this.pending))
    this.pending = ''
  }

  private separate(): void {
    if (this.parts++ > 0)
      this.b.add(' + ')
  }
}

// A template as code building its markup: what pages, layouts and static components render to outside islands, with no reactive runtime.
export class HtmlTemplate extends TemplateWriter {
  constructor(b: CodeBuilder, src: string, facts: TemplateFacts, private readonly options: HtmlOptions = {}) {
    super(b, src, facts)
  }

  // The nodes' markup as one string expression; an element's content lets a lone dynamic part go without markers.
  markup(nodes: Node[], inElement = false): void {
    const markup = new Markup(this.b)

    this.b.add('(')
    this.children(nodes, markup, false, inElement)
    markup.end()
    this.b.add(')')
  }

  // A rendered value, which a component returns and a prop carries.
  value(nodes: Node[]): void {
    this.b.add(helperName('html'))
    this.markup(nodes)
  }

  private children(nodes: Node[], markup: Markup, raw: boolean, inElement: boolean): void {
    const items = childItems(nodes)

    this.items(items, markup, raw, this.options.hydratable === true && !(inElement && soleDynamic(items)))
  }

  private items(items: Item[], markup: Markup, raw: boolean, markers: boolean): void {
    for (const [index, item] of items.entries()) {
      if (isDeclaration(item)) {
        // The items after it render inside a function declaring it, so its name reaches them alone.
        markup.dynamic(() => {
          const rest = new Markup(this.b)

          this.b.add('(() => { ')

          if (item.kind === 'snippet')
            this.snippetDeclaration(item.node)
          else
            this.b.wrap(item.node, () => constDeclaration(this.b, item.node, this.src, this.options.accessorLoops === true ? helperName('memo') : undefined))

          this.b.add('return (')
          this.items(items.slice(index + 1), rest, raw, markers)
          rest.end()
          this.b.add(') })()')
        })

        return
      }

      if (item.kind === 'text') {
        markup.text(raw ? item.text : escapeText(item.text))
      }
      else if (item.kind === 'element') {
        this.element(item.node, markup)
      }
      else {
        if (markers)
          markup.text(START_MARKER)

        markup.dynamic(() => this.dynamic(item, raw))

        if (markers)
          markup.text(END_MARKER)
      }
    }
  }

  private dynamic(item: DynamicItem, raw: boolean): void {
    const { b } = this

    switch (item.kind) {
      case 'expression':
        b.add(`${helperName(raw ? 'raw' : 'child')}((`).addSource(item.node.expression).add('))')

        break
      case 'component':
        b.wrap(item.node, () => this.component(item.node))

        break
      case 'slot':
        b.wrap(item.node, () => {
          b.add(`${helperName('child')}(`)
          slotValue(b, item.node)

          if (item.node.children.length > 0) {
            b.add(' ?? (')
            this.childrenValue(item.node.children)
            b.add(')')
          }

          b.add(')')
        })

        break
      case 'if':
        b.wrap(item.node, () => this.if(item.node, 0))

        break
      case 'match':
        // A `match` reads its subject once, which each case compares with its values.
        b.wrap(item.node, () => {
          b.add(`((${SUBJECT}) => `)
          this.match(item.node, 0)
          b.add(')(').addSource(item.node.subject).add(')')
        })

        break
      case 'for':
        this.for(item.node)

        break
      case 'await':
        this.await(item.node)

        break
      case 'try':
        this.try(item.node)

        break
      case 'error':
        this.error(item.node)

        break
    }
  }

  // Outside a form posting to an action, which `kay check` reports, it renders nothing.
  private error(node: ErrorNode): void {
    const { b } = this
    const target = this.facts.forms.get(node)

    if (!target) {
      b.add('""')

      return
    }

    b.wrap(node, () => {
      b.add(`${helperName('errorParagraph')}(KayFormError((`).addSource(target).add(`), ${JSON.stringify(node.name)}), ${errorParagraphArguments(node, this.src, this.options.errors?.lines.get(node))})`)
    })
  }

  private if(node: IfNode, index: number): void {
    const { b } = this
    const branch = node.branches[index]!

    b.wrap(branch, () => {
      const hasRest = index + 1 < node.branches.length || node.fallback !== undefined

      // The branch reads a named value through a function, as the island build of the same template does.
      if (branch.alias) {
        b.add(`${helperName('show')}((`).addSource(branch.test).add('), (').addSource(branch.alias).add(') => ')
        this.markup(branch.children)

        if (hasRest) {
          b.add(', () => ')
          this.ifRest(node, index + 1)
        }

        b.add(')')

        return
      }

      b.add('((').addSource(branch.test).add(') ? ')
      this.markup(branch.children)
      b.add(' : ')
      this.ifRest(node, index + 1)
      b.add(')')
    })
  }

  // What renders when the branches before `index` all fail: the next one, else the `else` block.
  private ifRest(node: IfNode, index: number): void {
    if (index < node.branches.length)
      this.if(node, index)
    else
      this.else(node.fallback)
  }

  private match(node: MatchNode, index: number): void {
    const { b } = this
    const branch = node.cases[index]

    if (!branch) {
      this.else(node.fallback)

      return
    }

    b.wrap(branch, () => {
      b.add('((')

      for (const [index, value] of branch.values.entries())
        b.add(index === 0 ? `${SUBJECT} === (` : ` || ${SUBJECT} === (`).addSource(value).add(')')

      b.add(') ? ')
      this.markup(branch.children)
      b.add(' : ')
      this.match(node, index + 1)
      b.add(')')
    })
  }

  private else(block: ElseBlock | undefined): void {
    if (block)
      this.b.wrap(block, () => this.markup(block.children))
    else
      this.b.add('""')
  }

  private for(node: ForNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${helperName('loop')}((`).addSource(node.each).add('), (').addSource(node.item)

      if (node.index)
        b.add(', ').addSource(node.index)

      b.add(') => ')
      this.markup(node.children)

      if (node.fallback) {
        b.add(', () => ')
        this.markup(node.fallback)
      }
      else if (this.options.accessorLoops) {
        b.add(', undefined')
      }

      if (this.options.accessorLoops)
        b.add(keyedByPosition(node, this.src) ? ', "positional"' : ', "keyed"')

      b.add(')')
    })
  }

  private try(node: TryNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${helperName('attempt')}(() => `)
      this.markup(node.children)

      const branch = node.rejected

      if (branch) {
        b.wrap(branch, () => {
          b.add(', (')

          if (branch.alias)
            b.addSource(branch.alias)

          b.add(') => ')
          this.markup(branch.children)
        })
      }

      b.add(')')
    })
  }

  private await(node: AwaitNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${helperName('child')}(KayAwait({ `)
      b.wrap(node.value, () => b.add('value'))
      b.add(': (').addSource(node.value).add(')')

      if (node.pending.length > 0) {
        b.add(', pending: () => ')
        this.value(node.pending)
      }

      for (const [prop, branch] of [['ready', node.resolved], ['failed', node.rejected]] as const) {
        if (!branch)
          continue

        b.wrap(branch, () => {
          b.add(`, ${prop}: (`)

          if (branch.alias)
            b.addSource(branch.alias)

          b.add(') => ')
          this.value(branch.children)
        })
      }

      b.add(' }))')
    })
  }

  private element(element: ElementNode, markup: Markup): void {
    const { b } = this

    if (element.attributes.some(attribute => attribute.kind === 'spread')) {
      markup.dynamic(() => b.wrap(element, () => this.spreadElement(element)))

      return
    }

    this.plainElement(element, markup)
  }

  private plainElement(element: ElementNode, markup: Markup): void {
    const { b } = this
    const name = element.name
    const children = element.children.filter(child => child.kind !== 'slot')
    const read = (expression: Span, call: boolean) => () => void b.add('(').addSource(expression).add(call ? ')()' : ')')
    const plan = this.plan(element, this.options.errors)
    const { target, field, action, described } = plan
    // What writes the content or the selected value: a bound one reads its signal.
    let content = plan.content && read(plan.content.expression, plan.content.bound)
    const selected = plan.selected && read(plan.selected.expression, plan.selected.bound)
    // The attribute a refused post's value goes back in, and what the template gives it otherwise.
    const filled = field?.fill === 'value' || field?.fill === 'checked' ? field.fill : undefined
    let ownFill: (() => void) | undefined
    let checkboxValue: (() => void) | undefined
    // A field takes the ids a component around it hands it, beside its own, unless its type shows no text to describe; a type an expression gives is decided as it renders, the expression read a second time for it.
    const type = plan.attributes.find(attribute => 'name' in attribute && attribute.name === 'type')
    const describable = FIELD_ELEMENTS.has(name) && !(type?.kind === 'text' && UNCHECKED_TYPES.has(type.text.toLowerCase()))
    let ownDescribed: (() => void) | undefined
    // A field written with its own `aria-required`, or of a type whose role takes none, is left as it is whatever a component around it asks; an expression for it is read a second time, as the type's is, and counts once it gives a value.
    const required = plan.attributes.find(attribute => 'name' in attribute && attribute.name === 'aria-required')
    const unrequirable = type?.kind === 'text' && UNREQUIRABLE_TYPES.has(type.text.toLowerCase())
    const fieldDescribed = (own: (() => void) | undefined) => {
      const typed = type?.kind === 'value' ? () => b.add('(').addSource(type.expression).add(')') : undefined
      const written = required?.kind === 'value' ? () => b.add('(').addSource(required.expression).add(')') : undefined
      const args = [own, typed, written ?? (required || unrequirable ? () => b.add('true') : undefined)]

      while (args.length > 0 && args.at(-1) === undefined)
        args.pop()

      b.add(`${helperName('fieldDescribed')}(`)

      for (const [index, arg] of args.entries()) {
        if (index > 0)
          b.add(', ')

        if (arg)
          arg()
        else
          b.add('undefined')
      }

      b.add(')')
    }

    markup.text(`<${name}${element.fixed ?? ''}`)

    if (plan.id !== undefined)
      markup.text(` id="${escapeStaticAttribute(plan.id)}"`)

    if (plan.classes?.expression) {
      const { text, expression } = plan.classes

      markup.text(' class="')
      markup.dynamic(() => b.add(`${helperName('className')}([${JSON.stringify(text)}, (`).addSource(expression).add(')])'))
      markup.text('"')
    }
    else if (plan.classes) {
      markup.text(` class="${escapeStaticAttribute(plan.classes.text)}"`)
    }

    for (const attribute of plan.attributes) {
      if (attribute.kind === 'behaviour' || (attribute.kind === 'bind' && name === 'textarea' && attribute.property === 'value'))
        continue

      // A bound value renders as the property it binds, read off its signal.
      if (attribute.kind === 'bind') {
        const value = read(attribute.expression, true)

        markup.dynamic(() => {
          b.add(`${helperName('attribute')}(${JSON.stringify(attribute.property)}, `)
          value()
          b.add(')')
        })

        continue
      }

      const written = attribute.kind === 'image' || attribute.kind === 'selected' ? WRITTEN_AS[attribute.kind] : attribute.name

      if (describable && written === 'aria-describedby') {
        // A bare `aria-describedby` is kept, written as an empty value.
        ownDescribed = attribute.kind === 'value' ? read(attribute.expression, false) : () => void b.add(JSON.stringify('text' in attribute ? attribute.text : ''))

        continue
      }

      if (written === filled) {
        if (attribute.kind === 'boolean')
          ownFill = () => void b.add('true')
        else if (attribute.kind === 'text' || attribute.kind === 'rooted')
          ownFill = () => void b.add(JSON.stringify(attribute.text))
        else
          ownFill = read(attribute.expression, false)

        continue
      }

      if (filled === 'checked' && written === 'value') {
        if (attribute.kind === 'boolean')
          checkboxValue = () => void b.add('""')
        else if (attribute.kind === 'text' || attribute.kind === 'rooted')
          checkboxValue = () => void b.add(JSON.stringify(attribute.text))
        else
          checkboxValue = read(attribute.expression, false)
      }

      switch (attribute.kind) {
        case 'boolean':
          markup.text(` ${attribute.name}`)

          break
        case 'text':
          markup.text(attribute.bare ? ` ${attribute.name}` : ` ${attribute.name}="${escapeStaticAttribute(attribute.text)}"`)

          if (attribute.name === 'href' && this.leavingLink(element) && mayLeaveSite(attribute.text))
            markup.dynamic(() => b.add(`${helperName('outsideLink')}(${JSON.stringify(attribute.text)}${this.named(element, 'rel') ? ', true' : ''})`))

          break
        case 'rooted':
          if (attribute.name === 'href' && this.localLink(element))
            markup.dynamic(() => b.add(`${helperName('attribute')}("href", ${helperName('localHref')}(${JSON.stringify(attribute.text)}))`))
          else
            markup.text(` ${attribute.name}="${escapeStaticAttribute(attribute.text)}"`)

          if (attribute.name === 'href' && this.leavingLink(element) && mayLeaveSite(attribute.text))
            markup.dynamic(() => b.add(`${helperName('outsideLink')}(${JSON.stringify(attribute.text)}${this.named(element, 'rel') ? ', true' : ''})`))

          break
        case 'class':
        case 'style':
          markup.dynamic(() => b.add(`${helperName('nonEmptyAttribute')}(${JSON.stringify(attribute.name)}, ${helperName(attribute.kind === 'class' ? 'className' : 'style')}((`).addSource(attribute.expression).add(')))'))

          break
        case 'image':
          markup.dynamic(() => {
            b.add(`${helperName('imageAttributes')}((`).addSource(attribute.expression).add(`), ${attribute.sized}`)
            this.sizesArgument(plan.sizes)

            if (!attribute.placeholder)
              b.add(`${plan.sizes ? '' : ', undefined'}, false`)

            b.add(')')
          })

          break
        case 'selected':
        case 'value':
          if (written === 'href' && this.leavingLink(element)) {
            markup.dynamic(() => {
              b.add(`${helperName('linkHref')}((`).addSource(attribute.expression).add(`), ${this.localLink(element)}, ${this.named(element, 'rel')})`)
            })

            break
          }

          markup.dynamic(() => {
            b.add(`${helperName('attribute')}(${JSON.stringify(written)}, `)

            if (attribute.kind === 'value' && attribute.action)
              b.add('KayFormAction((').addSource(attribute.expression).add('))')
            else if (written === 'href' && this.localLink(element))
              b.add(`${helperName('localHref')}((`).addSource(attribute.expression).add('))')
            else
              b.add('(').addSource(attribute.expression).add(')')

            b.add(')')
          })

          break
      }
    }

    this.currentLink(element, markup)

    if (field && target) {
      const fieldArguments = () => void b.add('((').addSource(target).add(`), ${JSON.stringify(field.name)}`)

      if (field.marked) {
        // Only an input takes a `type`, such as `email`.
        const written = [...(element.attributes as NamedAttribute[]).map(attribute => this.source(attribute.name)), ...name === 'input' ? [] : ['type']]

        markup.dynamic(() => {
          b.add(helperName('formConstraints'))
          fieldArguments()
          b.add(`, ${JSON.stringify(written)})`)
        })
      }

      if (filled) {
        markup.dynamic(() => {
          b.add(`${helperName('attribute')}(${JSON.stringify(filled)}, ${filled === 'value' ? 'KayFormValue' : 'KayFormChecked'}`)
          fieldArguments()

          // A radio button with no `value` posts `on`, as a checkbox does, but only the ticked one of its group.
          if (filled === 'checked') {
            b.add(', ')
            checkboxValue ? checkboxValue() : b.add(this.isRadio(element) ? '"on"' : 'undefined')
          }

          b.add(')')

          if (ownFill) {
            b.add(' ?? ')
            ownFill()
          }

          b.add(')')
        })
      }

      if (field.invalid) {
        markup.dynamic(() => {
          b.add(`${helperName('attribute')}("aria-invalid", KayFormInvalid`)
          fieldArguments()
          b.add('))')
        })

        // A refused field's description still takes the ids a component around it hands it, so a later field does not.
        if (described) {
          const refused = () => {
            b.add('KayFormInvalid')
            fieldArguments()
            b.add(describedValue(described))
          }

          markup.dynamic(() => {
            if (describable)
              return fieldDescribed(refused)

            b.add(`${helperName('attribute')}("aria-describedby", `)
            refused()
            b.add(')')
          })
        }
      }

      if (field.fill === 'content') {
        const own = content ?? (plan.valueText === undefined ? undefined : () => void b.add(JSON.stringify(plan.valueText)))

        content = () => {
          b.add('KayFormValue')
          fieldArguments()
          b.add(') ?? ')
          own ? own() : b.add('undefined')
        }
      }
    }

    if (describable && !described)
      markup.dynamic(() => fieldDescribed(ownDescribed))

    if (action) {
      if (action.method)
        markup.text(' method="post"')

      // Multipart whatever the schema, so file inputs post too; Elysia parses either encoding alike.
      if (action.enctype)
        markup.text(' enctype="multipart/form-data"')

      if (described)
        markup.dynamic(() => b.add(`${helperName('attribute')}("aria-describedby", KayFormInvalid((`).addSource(action.expression).add(`), ""${describedValue(described)})`))
    }

    const located = this.options.located?.(element)

    if (located !== undefined)
      markup.text(` data-kay-src="${escapeStaticAttribute(located)}"`)

    markup.text('>')

    if (VOID_ELEMENTS.has(name))
      return

    this.honeypot(element, () => markup.dynamic(() => this.honeypotField(element)))

    // A refused post's text takes the place of the textarea's static value.
    const staticContent = field?.fill === 'content' && plan.valueText !== undefined ? undefined : plan.staticContent

    if (children.length > 0 && field?.fill === 'selected' && target) {
      const own = selected

      markup.dynamic(() => {
        b.add(`${helperName('refillOptions')}(KayFormValue((`).addSource(target).add(`), ${JSON.stringify(field.name)}), `)
        this.markup(children, true)

        if (own) {
          b.add(', () => ')
          own()
        }

        b.add(')')
      })
    }
    else if (children.length > 0 && field?.fill === 'content' && target) {
      markup.dynamic(() => {
        b.add('((value) => value === undefined ? ')
        this.markup(children, true)
        b.add(` : ${helperName('child')}(value))(KayFormValue((`).addSource(target).add(`), ${JSON.stringify(field.name)}))`)
      })
    }
    else if (children.length > 0 && selected) {
      markup.dynamic(() => {
        b.add(`${helperName('selectOptions')}(`)
        selected()
        b.add(', ')
        this.markup(children, true)
        b.add(')')
      })
    }
    else if (children.length > 0) {
      this.children(children, markup, RAW_ELEMENTS.has(name), true)
    }
    else if (staticContent !== undefined) {
      markup.text(staticContent)
    }
    else if (content) {
      markup.dynamic(() => {
        b.add(`${helperName(plan.content?.raw === true ? 'raw' : 'child')}(`)
        content()
        b.add(')')
      })
    }

    markup.text(`</${name}>`)
  }

  // A link to the page being rendered says so, unless it says itself; an island's links are left to it, its markup claimed as the server wrote it.
  private currentLink(element: ElementNode, markup: Markup): void {
    if (element.name !== 'a' || this.options.hydratable || this.named(element, 'aria-current'))
      return

    const href = element.attributes.find(attribute => attribute.kind !== 'spread' && this.source(attribute.name) === 'href')

    if (!(href?.kind === 'expression' || (href?.kind === 'static' && fromRoot(decodeEntities(href.text)))))
      return

    const local = this.localLink(element)
    // `section` also marks the link on the pages below it.
    const section = sectionOf(element, this.src)

    markup.dynamic(() => {
      this.b.add(`${helperName('currentPage')}(${local ? `${helperName('localHref')}(` : ''}`)

      if (href.kind === 'static')
        this.b.add(JSON.stringify(decodeEntities(href.text)))
      else
        this.b.add('(').addSource(href.expression).add(')')

      if (local)
        this.b.add(')')

      if (section?.kind === 'boolean')
        this.b.add(', true')
      else if (section?.kind === 'expression')
        this.b.add(', !!(').addSource(section.expression).add(')')

      this.b.add(')')
    })
  }

  // A link that may leave the site, and so opens in a new tab unless it sets its own `target`.
  private leavingLink(element: ElementNode): boolean {
    return element.name === 'a' && !this.named(element, 'target')
  }

  // A link going to the page's locale's copy of what it names, as one carrying `hreflang` does not.
  private localLink(element: ElementNode): boolean {
    return element.name === 'a' && !this.named(element, 'hreflang')
  }

  // A form posting to an action renders the action's honeypot field first; an island leaves it to the template, its markup claimed node by node as it hydrates.
  private honeypot(element: ElementNode, emit: () => void): void {
    if (actionOf(element, this.src) && !this.options.hydratable)
      emit()
  }

  private honeypotField(element: ElementNode): void {
    this.b.add('KayFormProtection((').addSource(actionOf(element, this.src)!.expression).add('))')
  }

  // An element with a spread renders through `element`, which reads every attribute the spread brings at render time.
  private spreadElement(element: ElementNode): void {
    const { b } = this
    const children = element.children.filter(child => child.kind !== 'slot')

    b.add(`${helperName('element')}(${JSON.stringify(element.name)}, [`)
    this.leadingImageDefaults(element)
    this.sources(element, false)
    this.formDefaults(element)

    b.add(']')

    if (children.length > 0) {
      b.add(', () => ')
      this.honeypot(element, () => {
        this.honeypotField(element)
        b.add(' + ')
      })
      this.markup(children, true)
    }

    b.add(').t')
  }

  private component(element: ElementNode): void {
    const { b } = this
    const dynamic = b.isDynamicTag(element.tag)
    // What renders in the browser too renders whole: an island hydrates as one.
    const island = dynamic || this.options.hydratable === true ? undefined : serverIslandOf(element, this.src)

    b.add(`${helperName('child')}(`)

    if (dynamic)
      b.add(`${helperName('dynamic')}(`).addSource(element.tag).add(', ')
    else
      b.add(`${helperName(island ? 'serverIsland' : 'component')}(`).addSource(element.tag).add(', ')

    this.componentProps(element, false)

    if (island)
      b.add(`, ${JSON.stringify(island.mode ?? 'inline')}`)

    if (island?.noscript?.kind === 'static')
      b.add(`, ${JSON.stringify(decodeEntities(island.noscript.text))}`)
    else if (island?.noscript?.kind === 'expression')
      b.add(', (').addSource(island.noscript.expression).add(')')

    b.add('))')
  }

  protected rendered(nodes: Node[]): void {
    this.value(nodes)
  }

  // Handlers, refs and bindings only an island attaches; a component's other props all reach it.
  protected skips(element: ElementNode, name: string): boolean {
    return element.component ? marksServerIsland(element, name, this.src) : BEHAVIOUR.test(name)
  }

  private isRadio(element: ElementNode): boolean {
    return element.attributes.some(attribute => attribute.kind === 'static' && this.source(attribute.name) === 'type' && attribute.text.toLowerCase() === 'radio')
  }
}
