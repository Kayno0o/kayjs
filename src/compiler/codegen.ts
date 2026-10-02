import type { Attribute, Diagnostic, ElementNode, ForNode, IfNode, KayFile, Node, SlotNode, Span, TextNode } from './ast'
import type { Rewrite } from './mapping'
import type { ScriptAnalysis } from './script'
import { CodeBuilder } from './mapping'

export interface GenerateOptions {
  name: string
  // Set for an interactive component: its export is wrapped so the server renders it as an island root.
  island?: string
  // Final pass: rewrites from the analysis pass are applied and the props destructuring disappears.
  rewrites?: ReadonlyMap<number, Rewrite & { end: number }>
}

export interface Generated {
  builder: CodeBuilder
  // Generated offsets of parameters whose references must be called: loop items, loop indexes, narrowed `if` aliases.
  accessorSites: Set<number>
  diagnostics: Diagnostic[]
}

const JSX_TEXT_ESCAPES = /[{}<>]/g
const BINDABLE = new Set(['input', 'textarea', 'select'])
const NUMERIC_INPUTS = new Set(['number', 'range'])
const DEFAULT_PREFIX = '__default_'

export function defaultName(index: number): string {
  return `${DEFAULT_PREFIX}${index}`
}

export function generate(file: KayFile, script: ScriptAnalysis, options: GenerateOptions): Generated {
  return new Generator(file, script, options).run()
}

class Generator {
  private readonly b: CodeBuilder
  private readonly accessorSites = new Set<number>()
  private readonly diagnostics: Diagnostic[] = []
  private readonly src: string

  constructor(private readonly file: KayFile, private readonly script: ScriptAnalysis, private readonly options: GenerateOptions) {
    this.src = file.source
    this.b = new CodeBuilder(file.source, options.rewrites)
  }

  run(): Generated {
    const { b, script } = this

    for (const span of script.hoisted)
      b.addSource(span).add('\n')
    const helpers = usedHelpers(this.file.template, script)

    if (helpers.length > 0)
      b.add(`import { ${helpers.map(helper => `${helper} as ${helperAlias(helper)}`).join(', ')} } from 'solid-js'\n`)

    if (this.options.island)
      b.add(`import { island as KayIsland } from 'kay/island'\n`)

    b.add(`\n${this.options.island ? '' : 'export default '}function ${this.options.name}(`)

    if (script.props) {
      b.add('__props: ')

      if (script.props.type)
        b.addSource(script.props.type)
      else
        b.add('Record<string, unknown>')
    }

    b.add(') {\n')
    this.emitBody()
    b.add('\nreturn ')
    this.emitRoot(this.file.template)
    b.add('\n}\n')

    if (this.options.island)
      b.add(`\nexport default KayIsland(${JSON.stringify(this.options.island)}, ${this.options.name})\n`)

    return { builder: b, accessorSites: this.accessorSites, diagnostics: this.diagnostics }
  }

  // Script statements in source order, with the props declaration swapped for reads off `__props`.
  private emitBody() {
    const props = this.script.props
    let propsDone = !props

    for (const span of this.script.body) {
      if (!propsDone && props!.statement.start < span.start) {
        this.emitProps()
        propsDone = true
      }

      this.b.addSource(span)
    }

    if (!propsDone)
      this.emitProps()
  }

  private emitProps() {
    const { b } = this
    const props = this.script.props!

    b.add('\n')

    if (props.name)
      b.add('const ').addSource(props.name).add(' = __props;\n')

    for (const [index, binding] of props.bindings.entries()) {
      if (binding.fallback)
        b.add(`const ${defaultName(index)} = (`).addSource(binding.fallback).add(');\n')
    }

    if (props.rest)
      b.add('const ').addSource(props.rest).add(` = ${helperAlias('omit')}(__props, ${props.bindings.map(binding => JSON.stringify(binding.key)).join(', ')});\n`)

    // The analysis pass declares the destructured names so scope analysis can find every read of them; the final pass rewrites those reads instead.
    if (!this.options.rewrites && props.bindings.length > 0) {
      b.add('const { ')
      for (const binding of props.bindings)
        b.add(`${JSON.stringify(binding.key)}: `).addSource(binding.local).add(', ')
      b.add('} = __props;\n')
    }
  }

  private emitRoot(nodes: Node[]) {
    const visible = this.withoutSlots(nodes)

    if (visible.length === 1 && visible[0]!.kind === 'element') {
      this.emitElement(visible[0]!)

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
  private emitExpression(nodes: Node[]) {
    this.emitRoot(nodes)
  }

  private emitChildren(nodes: Node[]) {
    for (const node of nodes) {
      switch (node.kind) {
        case 'element':
          this.emitElement(node)

          break
        case 'text':
          this.emitText(node)

          break
        case 'if':
          this.b.wrap(node, () => {
            this.b.add('{')
            this.emitIf(node, 0)
            this.b.add('}')
          })

          break
        case 'for':
          this.emitFor(node)

          break
        case 'slot':
          this.reportSlot(node)

          break
      }
    }
  }

  private emitIf(node: IfNode, index: number) {
    const branch = node.branches[index]!
    const { b } = this

    b.wrap(branch, () => {
      if (!branch.test) {
        this.emitExpression(branch.children)

        return
      }

      const hasRest = index + 1 < node.branches.length

      if (branch.alias) {
        b.add(`<${helperAlias('Show')} when={`).addSource(branch.test).add('}')

        if (hasRest) {
          b.add(' fallback={')
          this.emitIf(node, index + 1)
          b.add('}')
        }

        b.add('>{(')
        this.accessorSites.add(b.code.length)
        b.addSource(branch.alias).add(') => ')
        this.emitExpression(branch.children)
        b.add(`}</${helperAlias('Show')}>`)

        return
      }

      b.add('(').addSource(branch.test).add(') ? ')
      this.emitExpression(branch.children)
      b.add(' : ')

      if (hasRest)
        this.emitIf(node, index + 1)
      else
        b.add('null')
    })
  }

  private emitFor(node: ForNode) {
    const { b } = this
    const tag = helperAlias('For')
    // A key naming the index means rows are matched by position: `for row, i of rows key={i}`.
    const positional = node.index !== undefined && this.text(node.key).trim() === this.text(node.index)

    b.wrap(node, () => {
      b.add(`<${tag} each={`).addSource(node.each).add('} keyed={')

      if (positional)
        b.add('false')
      else
        b.add('(').addSource(node.item).add(') => (').addSource(node.key).add(')')

      b.add('}')

      if (node.fallback) {
        b.add(' fallback={')
        this.emitExpression(node.fallback)
        b.add('}')
      }

      b.add('>{(')
      this.accessorSites.add(b.code.length)
      b.addSource(node.item)

      if (node.index) {
        b.add(', ')

        if (!positional)
          this.accessorSites.add(b.code.length)

        b.addSource(node.index)
      }

      b.add(') => ')
      this.emitExpression(node.children)
      b.add(`}</${tag}>`)
    })
  }

  private emitElement(element: ElementNode) {
    const { b } = this

    b.wrap(element, () => {
      b.add('<')

      if (element.tag.end > element.tag.start)
        b.addSource(element.tag)
      else
        b.add(element.name)

      this.emitAttributes(element)
      const slots = element.children.filter((child): child is SlotNode => child.kind === 'slot')

      for (const slot of slots) {
        if (!element.component) {
          this.reportSlot(slot)

          continue
        }

        b.add(' ').addSource(slot.name).add('={')
        this.emitExpression(slot.children)
        b.add('}')
      }
      const children = element.children.filter(child => child.kind !== 'slot')

      if (children.length === 0) {
        b.add(' />')

        return
      }

      b.add('>')
      this.emitChildren(children)
      b.add(`</${element.name}>`)
    })
  }

  private emitAttributes(element: ElementNode) {
    const { b } = this

    if (element.id) {
      if (element.attributes.some(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'id'))
        this.error(element.id, 'The id is set twice: by `#id` and by an `id` attribute')

      b.add(' id="').addSource(element.id).add('"')
    }

    const classAttributes = element.attributes.filter(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === 'class')

    if (classAttributes.length > 1)
      this.error(classAttributes[1]!.kind === 'spread' ? element : classAttributes[1]!.name, 'An element takes one `class` attribute; put several classes in it')

    if (element.classes.length > 0)
      this.emitShorthandClass(element, classAttributes[0])

    for (const attribute of element.attributes) {
      if (element.classes.length > 0 && attribute === classAttributes[0])
        continue

      b.add(' ')
      this.emitAttribute(element, attribute)
    }
  }

  private emitShorthandClass(element: ElementNode, attribute: Attribute | undefined) {
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
      b.addSource(attribute.name).add(`={[${JSON.stringify(shorthand)}, (`).addSource(attribute.expression).add(')]}')

      return
    }

    this.error(attribute.kind === 'spread' ? element : attribute.name, '`class` needs a value')
  }

  private emitAttribute(element: ElementNode, attribute: Attribute) {
    const { b } = this

    switch (attribute.kind) {
      case 'spread':
        b.add('{...').addSource(attribute.expression).add('}')

        return
      case 'boolean':
        if (this.text(attribute.name).startsWith('bind:'))
          this.error(attribute.name, '`bind:` needs a signal: `bind:value={name}`')

        b.addSource(attribute.name)

        return
      case 'static': {
        if (this.text(attribute.name).startsWith('bind:'))
          this.error(attribute.name, '`bind:` needs a signal: `bind:value={name}`')

        b.addSource(attribute.name).add('=')
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

        b.addSource(attribute.name).add('={').addSource(attribute.expression).add('}')
      }
    }
  }

  // `bind:value={name}` reads the signal and writes it back from the matching input event.
  private emitBind(element: ElementNode, attribute: Extract<Attribute, { kind: 'expression' }>, property: string) {
    const { b } = this

    if (element.component || !BINDABLE.has(element.name)) {
      this.error(attribute.name, '`bind:` works on <input>, <textarea> and <select>; pass a value and a setter to components')

      return
    }

    if (property !== 'value' && property !== 'checked') {
      this.error(attribute.name, `\`bind:${property}\` is not supported; use \`bind:value\` or \`bind:checked\``)

      return
    }

    const type = element.attributes.find(candidate => candidate.kind === 'static' && this.text(candidate.name) === 'type')
    const inputType = type?.kind === 'static' ? type.text : 'text'
    const event = property === 'checked' || element.name === 'select' ? 'onChange' : 'onInput'

    if (element.attributes.some(candidate => candidate.kind !== 'spread' && this.text(candidate.name) === event))
      this.error(attribute.name, `\`bind:${property}\` already handles \`${event}\`; drop one of them`)

    const read = property === 'checked' ? 'checked' : NUMERIC_INPUTS.has(inputType) ? 'valueAsNumber' : 'value'

    b.wrap(attribute.name, () => b.add(property))
    b.add('={(').addSource(attribute.expression).add(`)()} ${event}={(kayEvent) => (`).addSource(attribute.expression).add(`).set(kayEvent.currentTarget.${read})}`)
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

      const escaped = part.text.replace(JSX_TEXT_ESCAPES, char => `{'${char}'}`)

      if (escaped === this.text(part))
        b.addSource(part)
      else
        b.wrap(part, () => b.add(escaped))
    }
  }

  private withoutSlots(nodes: Node[]): Node[] {
    const visible: Node[] = []

    for (const node of nodes) {
      if (node.kind === 'slot')
        this.reportSlot(node)
      else
        visible.push(node)
    }

    return visible
  }

  private reportSlot(slot: SlotNode) {
    if (this.options.rewrites)
      return

    this.error(slot, `\`@${this.text(slot.name)}\` must sit directly under a component, to pass it as that component's \`${this.text(slot.name)}\` prop`)
  }

  private text(span: Span): string {
    return this.src.slice(span.start, span.end)
  }

  // Both passes generate the same code, so only the first one reports.
  private error(span: Span, message: string) {
    if (!this.options.rewrites)
      this.diagnostics.push({ start: span.start, end: span.end, message })
  }
}

const INTERACTIVE_ATTRIBUTE = /^(?:on[A-Z]|bind:|ref$)/

// A component needs the browser when it handles events, binds inputs, takes refs or holds reactive state.
export function isInteractive(file: KayFile, script: ScriptAnalysis): boolean {
  if (script.reactive)
    return true

  const visit = (nodes: Node[]): boolean => nodes.some((node) => {
    switch (node.kind) {
      case 'element':
        return node.attributes.some(attribute => attribute.kind !== 'spread' && INTERACTIVE_ATTRIBUTE.test(file.source.slice(attribute.name.start, attribute.name.end))) || visit(node.children)
      case 'text':
        return visit(node.parts.filter(part => part.kind === 'element'))
      case 'if':
        return node.branches.some(branch => visit(branch.children))
      case 'for':
        return visit(node.children) || visit(node.fallback ?? [])
      case 'slot':
        return visit(node.children)
    }

    return false
  })

  return visit(file.template)
}

type Helper = 'For' | 'Show' | 'omit'

function helperAlias(helper: Helper): string {
  return `Kay${helper[0]!.toUpperCase()}${helper.slice(1)}`
}

function usedHelpers(nodes: Node[], script: ScriptAnalysis): Helper[] {
  const used = new Set<Helper>()

  if (script.props?.rest)
    used.add('omit')

  const visit = (list: Node[]) => {
    for (const node of list) {
      if (node.kind === 'for') {
        used.add('For')
        visit(node.children)
        visit(node.fallback ?? [])
      }
      else if (node.kind === 'if') {
        for (const branch of node.branches) {
          if (branch.alias)
            used.add('Show')

          visit(branch.children)
        }
      }
      else if (node.kind === 'element' || node.kind === 'slot') {
        visit(node.children)
      }
      else {
        visit(node.parts.filter(part => part.kind === 'element'))
      }
    }
  }

  visit(nodes)

  return [...used]
}

// JSX attribute strings have no escapes, so pick a quote the value does not contain, or fall back to an expression.
function quoteAttribute(value: string): string {
  if (!value.includes('"'))
    return `"${value}"`

  if (!value.includes('\''))
    return `'${value}'`

  return `{${JSON.stringify(value)}}`
}
