import type { AwaitNode, ElementNode, ElseBlock, ErrorMessages, ErrorNode, ForNode, IfNode, MatchNode, NamedAttribute, Node, Span, TemplateFacts, TryNode } from './ast'
import type { DynamicItem, Item } from './items'
import type { CodeBuilder } from './mapping'
import type { ElementPlan } from './markup'
import type { LinkPlan } from './plan'
import { DATA_SCRIPT, LEADING_NEWLINE } from '../runtime/head'
import { mayLeaveSite } from '../runtime/outside'
import { actionOf, failedBlockOf, marksServerIsland, sectionOf, serverIslandOf } from './ast'
import { decodeEntities } from './expression'
import { addFieldDescribed, addInvalidAttribute } from './field-described'
import { addRowItem, childItems, constDeclaration, contentOf, errorParagraphArguments, isDeclaration, rowKeying, slotValue, soleDynamic } from './items'
import { addStyleArguments, END_MARKER, escapeStaticAttribute, escapeText, fromRoot, helperName, RAW_ELEMENTS, START_MARKER, TemplateWriter, VOID_ELEMENTS } from './markup'
import { LOAD_KEY, PROPS, SUBJECT } from './names'
import { addGroupChecked, BEHAVIOUR, checkedContent, describedValue, fieldAriaOf, groupValue, staticAttributeText } from './plan'

// The attribute an image's `src` or a select's `selected` value is written as.
const WRITTEN_AS = { image: 'src', selected: 'value' } as const
// A number written in the template, `0` or `-1.5`, as an attribute's whole expression.
const NUMBER_LITERAL = /^\s*-?\d+(?:\.\d+)?\s*$/
// The `kay/html` helpers static server output calls, each imported under a `Kay` name.
const HTML_HELPERS = ['attempt', 'attribute', 'checkedMarkup', 'child', 'className', 'component', 'componentClass', 'currentPage', 'dynamic', 'element', 'errorParagraph', 'fieldDescribed', 'formConstraints', 'head', 'html', 'imageAttributes', 'innerMarkup', 'leadingNewline', 'linkHref', 'localHref', 'loop', 'memo', 'merge', 'nonEmptyAttribute', 'omit', 'outsideLink', 'partClass', 'partHanded', 'partsClass', 'raw', 'rawData', 'rawTyped', 'refillOptions', 'selectOptions', 'serverIsland', 'show', 'spreadAttributes', 'spreadWith', 'style', 'untrack']

// The helper writing an element's content expression that is not raw text: an `innerHTML` as the markup it is, anything else as text.
function contentHelper(content: { property: string, raw: boolean } | undefined): string {
  return content?.property === 'innerHTML' ? 'innerMarkup' : 'child'
}

// How the expressions inside `script` and `style` text are written: a script holding JSON writes `<` as `\u003c`, where other raw text breaks it with a backslash, and a script whose type an expression gives decides as it renders, the expression read again for each.
type RawText = 'raw' | 'rawData' | { typed: () => void }

const NEWLINE_START = /^[\r\n]/

// Whether an element's content may start with a newline: not when it is static or opens with an element or a text that does not.
function mayStartWithNewline(children: Node[], fill: string | undefined, plan: ElementPlan): boolean {
  if (fill === 'content')
    return true

  if (children.length === 0)
    return plan.staticContent === undefined ? plan.content !== undefined : NEWLINE_START.test(decodeEntities(plan.staticContent))

  const first = childItems(children)[0]

  if (first === undefined || first.kind === 'element')
    return false

  return first.kind !== 'text' || NEWLINE_START.test(decodeEntities(first.text))
}

export function htmlHelperImport(): string {
  return `import { ${HTML_HELPERS.map(helper => `${helper} as ${helperName(helper)}`).join(', ')} } from 'kay/html'\n`
}

export interface HtmlOptions {
  // The app has Tailwind, so a class table may merge classes while rendering.
  classMerge?: boolean | undefined
  // An island or a twin: dynamic parts carry markers for hydration.
  hydratable?: boolean | undefined
  // Loop rows read their item, and a keyed row its index, through functions, as the island build of the same template does.
  accessorLoops?: boolean | undefined
  // What a refused form's fields are described by.
  errors?: ErrorMessages | undefined
  // Development: the source position each element carries for `kay dev`'s inspector.
  located?: ((element: ElementNode) => string | undefined) | undefined
  // A refresh naming some of the page's loads leaves an element reading none of them to the page as it is: the group of each such element by where it starts, with the id it carries.
  kept?: { groups: ReadonlyMap<number, { group: number, id: string }> } | undefined
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
  // The names the `try` blocks being written give their `catch`, which an `await` without a `catch` inside falls back to: the runtime hands the function, or one rendering nothing, to the content of the `try`.
  private readonly catches: string[] = []

  constructor(b: CodeBuilder, src: string, facts: TemplateFacts, ownMarkup: (name: string, at: number) => boolean, private readonly options: HtmlOptions = {}) {
    super(b, src, facts, ownMarkup)
    this.mergesAtRuntime = options.classMerge === true
  }

  // The nodes' markup as one string expression; an element's content lets a lone dynamic part go without markers.
  markup(nodes: Node[], inElement = false): void {
    const markup = new Markup(this.b)

    this.b.add('(')
    this.children(nodes, markup, undefined, inElement)
    markup.end()
    this.b.add(')')
  }

  // A rendered value, which a component returns and a prop carries.
  value(nodes: Node[]): void {
    this.b.add(helperName('html'))
    this.markup(nodes)
  }

  private children(nodes: Node[], markup: Markup, raw: RawText | undefined, inElement: boolean): void {
    const items = childItems(nodes)

    this.items(items, markup, raw, this.options.hydratable === true && !(inElement && soleDynamic(items)))
  }

  private items(items: Item[], markup: Markup, raw: RawText | undefined, markers: boolean): void {
    for (const [index, item] of items.entries()) {
      if (isDeclaration(item)) {
        // The items after it render inside a function declaring it, so its name reaches them alone.
        markup.dynamic(() => {
          const rest = new Markup(this.b)

          // A type expression is read before the declaration, whose name may shadow one it holds.
          const typed = typeof raw === 'object'
          const inner: RawText | undefined = typed ? { typed: () => void this.b.add('KayRawType') } : raw

          if (typed) {
            this.b.add('((KayRawType) => ')
          }

          this.b.add('(() => { ')

          if (item.kind === 'snippet')
            this.snippetDeclaration(item.node)
          else
            this.b.wrap(item.node, () => constDeclaration(this.b, item.node, this.src, this.options.accessorLoops === true ? helperName('memo') : undefined))

          this.b.add('return (')
          this.items(items.slice(index + 1), rest, inner, markers)
          rest.end()
          this.b.add(') })()')

          if (typed) {
            this.b.add(')(')
            raw.typed()
            this.b.add(')')
          }
        })

        return
      }

      if (item.kind === 'text') {
        markup.text(raw !== undefined ? item.text : escapeText(item.text))
      }
      else if (item.kind === 'element') {
        this.element(item.node, markup)
      }
      else {
        // A block written for the layout above renders nothing here, so hydration has no part to find.
        const marked = markers && !(item.kind === 'component' && item.node.fills)

        if (marked)
          markup.text(START_MARKER)

        markup.dynamic(() => this.dynamic(item, raw))

        if (marked)
          markup.text(END_MARKER)
      }
    }
  }

  // Opens the call writing an expression as raw text, its argument and the closing parenthesis following.
  private openRaw(raw: RawText): void {
    if (typeof raw === 'string') {
      this.b.add(`${helperName(raw)}(`)

      return
    }

    this.b.add(`${helperName('rawTyped')}(`)
    raw.typed()
    this.b.add(', ')
  }

  private dynamic(item: DynamicItem, raw: RawText | undefined): void {
    const { b } = this

    switch (item.kind) {
      case 'expression':
        if (raw !== undefined)
          this.openRaw(raw)
        else
          b.add(`${helperName('child')}(`)

        b.add('(').addSource(item.node.expression).add('))')

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
      b.add(`${helperName('loop')}((`).addSource(node.each).add('), (')
      addRowItem(b, node)

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
        b.add(rowKeying(node, this.src).kind === 'positional' ? ', "positional"' : ', "keyed"')

      b.add(')')
    })
  }

  private try(node: TryNode): void {
    const { b } = this

    b.wrap(node, () => {
      const name = `KayCatch${this.catches.length}`

      b.add(`${helperName('attempt')}((${name}) => `)
      this.catches.push(name)
      this.markup(node.children)
      this.catches.pop()

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

  // A branch rendered once its value settles, after the form around it has popped its scope, so it renders in that form's again.
  private scoped(node: Node, render: () => void): void {
    const form = this.facts.forms.get(node)

    if (!form) {
      render()

      return
    }

    this.b.add(`${helperName('formScope')}((`).addSource(form).add('), () => ')
    render()
    this.b.add(')')
  }

  private await(node: AwaitNode): void {
    const { b } = this

    b.wrap(node, () => {
      b.add(`${helperName('child')}(KayAwait({ `)
      b.wrap(node.value, () => b.add('value'))
      b.add(': (').addSource(node.value).add(')')

      if (node.pending.length > 0) {
        b.add(', pending: () => ')
        this.scoped(node, () => this.value(node.pending))
      }

      for (const [prop, branch] of [['ready', node.resolved], ['failed', node.rejected]] as const) {
        if (!branch)
          continue

        b.wrap(branch, () => {
          b.add(`, ${prop}: (`)

          if (branch.alias)
            b.addSource(branch.alias)

          b.add(') => ')
          this.scoped(node, () => this.value(branch.children))
        })
      }

      // With no `catch` of its own, a rejection renders the enclosing `try`'s, or nothing when that has none.
      if (!node.rejected && this.catches.length > 0)
        b.add(`, fallback: (error) => ${helperName('html')}(${this.catches.at(-1)!}(error))`)

      b.add(' }))')
    })
  }

  private element(element: ElementNode, markup: Markup): void {
    const { kept } = this.options
    const unit = kept?.groups.get(element.start)

    if (kept === undefined || unit === undefined) {
      this.written(element, markup)

      return
    }

    const { b } = this

    markup.dynamic(() => {
      const shown = new Markup(b)

      b.add(`(${PROPS}[${LOAD_KEY}]?.(${unit.group}) ? ${JSON.stringify(`<${element.name} data-kay-kept data-kay-u="${unit.id}">${VOID_ELEMENTS.has(element.name) ? '' : `</${element.name}>`}`)} : `)
      this.written(element, shown)
      shown.end()
      b.add(')')
    })
  }

  private written(element: ElementNode, markup: Markup): void {
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
    const children = contentOf(element)
    const read = (expression: Span, call: boolean) => () => void b.add('(').addSource(expression).add(call ? ')()' : ')')
    const plan = this.plan(element, this.options.errors)
    const { target, field, action, described, link } = plan
    // What writes the content or the selected value: a bound one reads its signal.
    let content = checkedContent(this.b, helperName('checkedMarkup'), this.src, this.ownMarkup, plan.content, plan.content && read(plan.content.expression, plan.content.bound))
    const selected = plan.selected && read(plan.selected.expression, plan.selected.bound)
    // The attribute a refused post's value goes back in, and what the template gives it otherwise.
    const filled = field?.fill === 'value' || field?.fill === 'checked' ? field.fill : undefined
    let ownFill: (() => void) | undefined
    let checkboxValue: (() => void) | undefined
    // A field takes the ids a component around it hands it, beside its own, unless its type shows no text to describe; a type an expression gives is decided as it renders, the expression read a second time for it.
    const type = plan.attributes.find(attribute => 'name' in attribute && attribute.name === 'type')
    const fieldAria = fieldAriaOf(name, type, plan.attributes)
    const describable = fieldAria !== undefined
    let ownDescribed: (() => void) | undefined
    let refusing: (() => void) | undefined
    const fieldDescribed = (own: (() => void) | undefined, refusing?: () => void) => addFieldDescribed(b, own, type, fieldAria, refusing)

    markup.text(`<${name}${element.fixed ?? ''}`)

    if (plan.id !== undefined)
      markup.text(` id="${escapeStaticAttribute(plan.id)}"`)

    const unit = this.options.kept?.groups.get(element.start)

    if (unit !== undefined)
      markup.text(` data-kay-u="${unit.id}"`)

    if (plan.classes?.parts) {
      const classes = plan.classes

      markup.dynamic(() => {
        b.add(`${helperName('nonEmptyAttribute')}("class", ${helperName('className')}(`)
        this.classList(classes)
        b.add('))')
      })
    }
    else if (plan.classes?.expression) {
      const { text, expression } = plan.classes

      markup.text(' class="')
      markup.dynamic(() => b.add(`${helperName('className')}([${JSON.stringify(text)}, (`).addSource(expression).add(')])'))
      markup.text('"')
    }
    else if (plan.classes?.pieces) {
      const { pieces } = plan.classes

      markup.text(' class="')
      markup.dynamic(() => b.add(`${helperName('className')}(${JSON.stringify(pieces)})`))
      markup.text('"')
    }
    else if (plan.classes) {
      markup.text(` class="${escapeStaticAttribute(plan.classes.text)}"`)
    }

    for (const attribute of plan.attributes) {
      if (attribute.kind === 'binding') {
        const { binding } = attribute

        // Handlers, refs and transitions are the browser's; a file input is never given a value, and a textarea's value is its content.
        if (binding.kind !== 'bind' || binding.property === 'files' || (binding.property === 'value' && name === 'textarea'))
          continue

        // A box of a group is checked when the group holds its value.
        if (binding.property === 'group') {
          const value = groupValue(element, span => this.source(span))

          markup.dynamic(() => {
            b.add(`${helperName('attribute')}("checked", `)
            addGroupChecked(b, binding.expression, value)
            b.add(')')
          })

          continue
        }

        // A bound value renders as the property it binds, read off its signal.
        markup.dynamic(() => {
          b.add(`${helperName('attribute')}(${JSON.stringify(binding.property)}, `)
          read(binding.expression, true)()
          b.add(')')
        })

        continue
      }

      if (attribute.kind === 'style') {
        markup.dynamic(() => {
          b.add(`${helperName('nonEmptyAttribute')}("style", ${helperName('style')}(`)
          addStyleArguments(b, attribute)
          b.add('))')
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

          if (attribute.name === 'href' && link.leaving && mayLeaveSite(attribute.text))
            markup.dynamic(() => b.add(`${helperName('outsideLink')}(${JSON.stringify(attribute.text)}${link.rel ? ', true' : ''})`))

          break
        case 'rooted':
          if (attribute.name === 'href' && link.local)
            markup.dynamic(() => b.add(`${helperName('attribute')}("href", ${helperName('localHref')}(${JSON.stringify(attribute.text)}))`))
          else
            markup.text(` ${attribute.name}="${escapeStaticAttribute(attribute.text)}"`)

          if (attribute.name === 'href' && link.leaving && mayLeaveSite(attribute.text))
            markup.dynamic(() => b.add(`${helperName('outsideLink')}(${JSON.stringify(attribute.text)}${link.rel ? ', true' : ''})`))

          break
        case 'class':
          markup.dynamic(() => b.add(`${helperName('nonEmptyAttribute')}(${JSON.stringify(attribute.name)}, ${helperName('className')}((`).addSource(attribute.expression).add(')))'))

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
          if (written === 'href' && link.leaving) {
            markup.dynamic(() => {
              b.add(`${helperName('linkHref')}((`).addSource(attribute.expression).add(`), ${link.local}, ${link.rel})`)
            })

            break
          }

          markup.dynamic(() => {
            b.add(`${helperName('attribute')}(${JSON.stringify(written)}, `)

            if (attribute.kind === 'value' && attribute.action)
              b.add('KayFormAction((').addSource(attribute.expression).add('))')
            else if (written === 'href' && link.local)
              b.add(`${helperName('localHref')}((`).addSource(attribute.expression).add('))')
            else
              b.add('(').addSource(attribute.expression).add(NUMBER_LITERAL.test(this.source(attribute.expression)) ? '), true' : ')')

            b.add(')')
          })

          break
      }
    }

    this.currentLink(element, markup, link)

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
        refusing = fieldArguments

        markup.dynamic(() => addInvalidAttribute(b, fieldArguments))

        // A refused field's description still takes the ids a component around it hands it, so a later field does not.
        if (described) {
          const refused = () => {
            b.add('KayFormInvalid')
            fieldArguments()
            b.add(describedValue(described))
          }

          markup.dynamic(() => {
            if (describable)
              return fieldDescribed(refused, refusing)

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
      markup.dynamic(() => fieldDescribed(ownDescribed, refusing))

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

    const body = (markup: Markup): void => {
      let rawText: RawText | undefined

      if (RAW_ELEMENTS.has(name)) {
        if (name !== 'script' || !type)
          rawText = 'raw'
        else if (type.kind === 'text')
          rawText = DATA_SCRIPT.test(type.text) ? 'rawData' : 'raw'
        else if (type.kind === 'value')
          rawText = { typed: read(type.expression, false) }
        else
          rawText = 'raw'
      }

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
        this.children(children, markup, rawText, true)
      }
      else if (staticContent !== undefined) {
        markup.text(staticContent)
      }
      else if (content) {
        markup.dynamic(() => {
          if (plan.content?.raw === true && rawText !== undefined)
            this.openRaw(rawText)
          else
            b.add(`${helperName(contentHelper(plan.content))}(`)

          content()
          b.add(')')
        })
      }
    }

    // HTML drops the first newline of these, so the server writes one more when the content may start with one.
    if (LEADING_NEWLINE.has(name) && mayStartWithNewline(children, field?.fill, plan)) {
      markup.dynamic(() => {
        const inner = new Markup(b)

        b.add(`${helperName('leadingNewline')}(`)
        body(inner)
        inner.end()
        b.add(')')
      })
    }
    else if (action && children.length > 0) {
      // The components inside read the form's action as they render, to show a refused post's values again.
      markup.dynamic(() => {
        const inner = new Markup(b)

        b.add(`${helperName('formScope')}((`).addSource(action.expression).add('), () => ')
        body(inner)
        inner.end()
        b.add(')')
      })
    }
    else {
      body(markup)
    }

    markup.text(`</${name}>`)
  }

  // A link to the page being rendered says so, unless it says itself; an island's too, its markup claimed as the server wrote it, and the swap of a page keeping the island carries the next page's marks over.
  private currentLink(element: ElementNode, markup: Markup, { local }: LinkPlan): void {
    if (element.name !== 'a' || this.named(element, 'aria-current'))
      return

    const href = element.attributes.find(attribute => attribute.kind !== 'spread' && this.source(attribute.name) === 'href')

    if (!(href?.kind === 'expression' || (href?.kind === 'static' && fromRoot(decodeEntities(href.text)))))
      return

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

  // A form posting to an action renders the action's honeypot field first; an island's sits between comments, as the browser sets it aside while it claims the form's content and puts it back.
  private honeypot(element: ElementNode, emit: () => void): void {
    if (actionOf(element, this.src))
      emit()
  }

  private honeypotField(element: ElementNode): void {
    this.b.add('KayFormProtection((').addSource(actionOf(element, this.src)!.expression).add(this.options.hydratable ? '), true)' : '))')
  }

  // An element with a spread renders through `element`, which reads every attribute the spread brings at render time.
  private spreadElement(element: ElementNode): void {
    const { b } = this
    const children = contentOf(element)

    b.add(`${helperName('element')}(${JSON.stringify(element.name)}, `)
    this.spreadOver(element, () => {
      this.leadingImageDefaults(element)
      this.sources(element, false)
      this.formDefaults(element)
    })

    if (children.length > 0) {
      const action = actionOf(element, this.src)

      b.add(', () => ')

      // The fields in a form spreading its attributes read its action as they render, as in one that does not.
      if (action)
        b.add(`${helperName('formScope')}((`).addSource(action.expression).add('), () => ')

      this.honeypot(element, () => {
        this.honeypotField(element)
        b.add(' + ')
      })
      this.markup(children, true)

      if (action)
        b.add(')')
    }

    b.add(').t')
  }

  private component(element: ElementNode): void {
    const { b } = this

    // A block at the root of a page, kept for the layout above and rendering nothing where it stands.
    if (element.fills) {
      b.add(`${helperName('fill')}(${JSON.stringify(this.source(element.fills))}, () => (`)
      this.childrenValue(element.children)
      b.add('))')

      return
    }

    const dynamic = b.isDynamicTag(element.tag)
    // What renders in the browser too renders whole: an island hydrates as one.
    const island = dynamic || this.options.hydratable === true ? undefined : serverIslandOf(element, this.src)

    b.add(`${helperName('child')}(`)

    if (dynamic)
      b.add(`${helperName('dynamic')}(`).addSource(element.tag).add(', ')
    else
      b.add(`${helperName(island ? 'serverIsland' : 'component')}(`).addSource(element.tag).add(', ')

    const failed = island ? failedBlockOf(element, this.src) : undefined

    this.componentProps(element, false, failed)

    if (island)
      b.add(`, ${JSON.stringify(island.mode ?? 'inline')}`)

    if (island?.noscript?.kind === 'static')
      b.add(`, ${JSON.stringify(decodeEntities(island.noscript.text))}`)
    else if (island?.noscript?.kind === 'expression')
      b.add(', (').addSource(island.noscript.expression).add(')')
    else if (failed)
      b.add(', undefined')

    if (failed) {
      b.add(', () => ')
      this.childrenValue(failed.children)
    }

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
    return staticAttributeText(element, 'type', this.src)?.toLowerCase() === 'radio'
  }
}
