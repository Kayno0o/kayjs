import type { Attribute, Details, Diagnostic, ElementNode, KayFile, Labelled, NamedAttribute, Node, ServerIslandMark, Span } from './ast'
import type { GenerateOptions } from './codegen'
import type { LintName } from './lints'
import type { PageSettingName } from './page-settings'
import type { ImportBinding, ScriptAnalysis, ServerAnalysis } from './script'
import { RESIZABLE } from '../runtime/image'
import { WIDGET_ROLES } from './aria'
import { childBlocks, FIELD_ATTRIBUTE, FIELD_ELEMENTS, isHead, isSlot, serverIslandOf, templateFacts } from './ast'

type ValidateOptions = Pick<GenerateOptions, 'island' | 'insideIsland' | 'check' | 'special' | 'includeServer' | 'pageFile'>

// The elements each property of an element can be bound to; `group` and `files` also need an input of a type, `radio` or `checkbox` and `file`.
const BINDABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map([['value', new Set(['input', 'textarea', 'select'])], ['checked', new Set(['input', 'textarea', 'select'])], ['group', new Set(['input'])], ['files', new Set(['input'])], ['open', new Set(['details', 'dialog'])]])
const GROUP_TYPES = new Set(['radio', 'checkbox'])
const TRANSITION_PART = 'transition:'

const TRANSITION_PARTS = new Set(['enter', 'enter-from', 'enter-to', 'leave', 'leave-from', 'leave-to'])
const LOWERCASE_EVENT = /^on:?([a-z]+)$/
const WHITESPACE = /\s+/
// A part's name, which becomes a key of the component's `class` type.
const PART_NAME = /^[A-Z][\w-]*$/i
// A `class` member of a props type, as the text of the type: one of its own members, not of a type nested in it.
const CLASS_MEMBER = /^(?:class|'class'|"class")\??\s*:/
const MEMBER_START = /[\s{;,]/
const TYPE_OPENERS = '{[(<'
const TYPE_CLOSERS = '}])>'
// The name a `bind:` on a component writes: a signal, a prop of the component, or a member of one.
const BOUND_NAME = /^\s*[A-Z_$][\w$]*(?:\s*\.\s*[A-Z_$][\w$]*)*\s*$/i
// `files.url(key)` alone: a stored file's URL holds its size, which kay writes on the `img` showing it, but not once more is joined to it.
const STORED_URL = /^[\w.]+\.url\((?:[^()]|\([^()]*\))*\)$/
const COMPOUND_EVENT = /^(dbl|key|mouse|pointer|touch|drag|focus|context|before|after)(click|down|up|press|move|enter|leave|over|out|start|end|cancel|in|menu|input)$/
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'html'])
const HEAD_CONTENT = 'A `head` block holds `title`, `meta`, `link`, `style`, `script`, `base` and `html` elements only'
const QUERY: PageSettingName = 'query'
// Inside `svg` and `math`, HTML reads a `style` or `script` as markup, not text, back to HTML in a `foreignObject`.
const FOREIGN = new Set(['svg', 'math'])
const RAW_TEXT = new Set(['style', 'script'])
const CONTENT_ATTRIBUTES = new Set(['innerHTML', 'textContent', 'innerText', 'children'])
// One string literal, the way CSS with braces is written in a template's text.
const STRING_LITERAL = /^\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)\s*$/
// What only a static parent passes an island.
const ISLAND_OPTIONS = new Set(['hydrate', 'persist'])
// Elements a keyboard reaches and a screen reader announces as controls; a click handler on any other one needs a control's `role`.
const INTERACTIVE_TAGS = new Set(['a', 'audio', 'button', 'details', 'embed', 'iframe', 'input', 'label', 'object', 'option', 'select', 'summary', 'textarea', 'video'])
// An attribute an element needs to be understood without seeing it, and what to write.
const REQUIRED_TEXT = new Map<string, [attribute: string, message: string, help: string]>([
  ['img', ['alt', 'An `img` needs `alt`', 'say what it shows, or write `alt=""` when it is only decoration']],
  ['iframe', ['title', 'An `iframe` needs a `title`', 'name what it holds, which screen readers announce']],
])

// What the compiler reports of a component's fences and template, in a pass of its own beside code generation: the fences' imports and page rules, then the template as it is written.
export function validate(file: KayFile, script: ScriptAnalysis, server: ServerAnalysis | undefined, options: ValidateOptions): Diagnostic[] {
  return new Validator(file, options).run(script, server)
}

// Both fences land in one module, so a name they both import is declared once, the server fence's copy left out; a name imported two different ways conflicts.
export function sharedImports(script: ScriptAnalysis, server: ServerAnalysis): { duplicates: ImportBinding[], conflicts: [binding: ImportBinding, first: ImportBinding][] } {
  const seen = new Map(script.imports.map(binding => [binding.local, binding]))
  const duplicates: ImportBinding[] = []
  const conflicts: [ImportBinding, ImportBinding][] = []

  for (const binding of server.imports) {
    const first = seen.get(binding.local)

    if (!first)
      seen.set(binding.local, binding)
    else if (first.imported === binding.imported && first.source === binding.source && (binding.typeOnly || !first.typeOnly))
      duplicates.push(binding)
    else
      conflicts.push([binding, first])
  }

  return { duplicates, conflicts }
}

// Why a child of the `head` block cannot be one of its tags, or nothing when it can.
export function headTagProblem(node: Node): [at: Span, message: string] | undefined {
  if (node.kind !== 'element' || node.component || !HEAD_TAGS.has(node.name))
    return [node, HEAD_CONTENT]

  if (node.name === 'html' && node.children.length > 0)
    return [node.children[0]!, '`html` holds nothing: it sets the attributes of `<html>`']

  const nested = node.children.find(child => child.kind !== 'text' || child.parts.some(part => part.kind === 'element'))

  return nested && [nested, `\`${node.name}\` holds text only`]
}

// Why `bind:` cannot bind this property of this element, or nothing when it can. `type` is the static `type` of an input, if it has one.
export function bindProblem(element: ElementNode, property: string, inputType?: string): [message: string, details: Details] | undefined {
  const type = inputType?.toLowerCase()

  if (element.component)
    return ['`bind:` works on elements and, with a `Bindable` prop, on components', { help: 'pass a component a value and a setter' }]

  const elements = BINDABLE.get(property)

  if (elements === undefined)
    return [`\`bind:${property}\` is not supported`, { help: 'use `bind:value`, `bind:checked`, `bind:group`, `bind:files` or `bind:open`' }]

  if (!elements.has(element.name))
    return [`\`bind:${property}\` works on ${[...elements].map(name => `<${name}>`).join(', ')} only`, { help: 'pass a component a value and a setter' }]

  if (property === 'group' && !GROUP_TYPES.has(type ?? ''))
    return ['`bind:group` needs an input with a static type="radio" or type="checkbox"', { help: '`input(type="radio" value="a" bind:group={choice})`' }]

  if (property === 'files' && type !== 'file')
    return ['`bind:files` needs an input with a static type="file"', { help: '`input(type="file" bind:files={files})`' }]

  return undefined
}

// The event `bind:` writes the signal back from: a dialog closes with `close`, a details toggles.
export function bindEvent(element: ElementNode, property: string): string {
  if (property === 'open')
    return element.name === 'dialog' ? 'onClose' : 'onToggle'

  return property === 'checked' || property === 'group' || property === 'files' || element.name === 'select' ? 'onChange' : 'onInput'
}

// The index of the quote closing the string literal opened at `start`.
function literalEnd(type: string, start: number): number {
  for (let index = start + 1; index < type.length; index++) {
    if (type[index] === '\\')
      index++
    else if (type[index] === type[start])
      return index
  }

  return type.length
}

// Whether a props type, written as text, has a `class` member of its own: one at the first level of a `{ ... }`, not inside a type nested in it, as `style: { class?: string }` is.
function declaresClass(type: string): boolean {
  const open: string[] = []

  for (let index = 0; index < type.length; index++) {
    const char = type[index]!

    if (char === '\'' || char === '"' || char === '`') {
      // A string literal type: a member name is tested first, then the literal is skipped whole, so a brace or `>` inside it counts for nothing.
      if (open.length === 1 && open[0] === '{' && MEMBER_START.test(type[index - 1] ?? '{') && CLASS_MEMBER.test(type.slice(index)))
        return true

      index = literalEnd(type, index)
    }
    else if (TYPE_OPENERS.includes(char)) {
      open.push(char)
    }
    else if (char === '>' && type[index - 1] === '=') {
      continue
    }
    else if (TYPE_CLOSERS.includes(char)) {
      open.pop()
    }
    else if (open.length === 1 && open[0] === '{' && MEMBER_START.test(type[index - 1] ?? '{') && CLASS_MEMBER.test(type.slice(index))) {
      return true
    }
  }

  return false
}

class Validator {
  private readonly diagnostics: Diagnostic[] = []
  // The `html` tags of the `head` block, the only place one sets attributes.
  private readonly rootTags = new Set<Node>()
  private readonly src: string
  private readonly forms: Map<Node, Span>
  private foreign = false
  // The names bound to an imported PNG, JPEG, WebP, GIF or AVIF, whose size kay writes on the `img` showing them.
  private sizedImports = new Set<string>()
  // The name of the props the script left out of its destructuring: a plain object, whose members are values.
  private restName: string | undefined

  constructor(private readonly file: KayFile, private readonly options: ValidateOptions) {
    this.src = file.source
    this.forms = templateFacts(file).forms
  }

  run(script: ScriptAnalysis, server: ServerAnalysis | undefined): Diagnostic[] {
    this.restName = script.props?.rest && this.text(script.props.rest)
    this.sizedImports = new Set([...script.imports, ...(server?.imports ?? [])].filter(binding => binding.imported === 'default' && !binding.typeOnly && RESIZABLE.test(binding.source)).map(binding => binding.local))

    if (server && this.options.includeServer !== false) {
      for (const [binding, first] of sharedImports(script, server).conflicts)
        this.error(binding.span, `\`${binding.local}\` is imported twice, once in each fence, and not the same way`, { related: [{ ...first.span, label: 'first imported here' }], help: 'import it once' })
    }

    const query = server?.page?.settings.get(QUERY)?.key

    if (query && this.options.special)
      this.error(query, 'Only a page or a layout declares its query', { help: 'read the route\'s query through `ctx.query`' })

    const head = this.head(this.file.template)

    if (this.file.typeParameters && server)
      this.error(this.file.typeParameters, 'A page has no type parameters', { note: 'a page gets its data from `--- server` and takes no props' })

    if (this.options.pageFile === true && script.recipeSpan)
      this.error(script.recipeSpan, 'A page or a layout takes no variants', { note: 'a recipe types the props of a component, which a page does not have', help: 'move the recipe to a component' })

    const parts = this.options.pageFile === true ? undefined : templateFacts(this.file, script.recipe).parts

    if (parts) {
      const type = script.props?.type
      const taken: Span | undefined = script.props?.bindings.find(binding => binding.key === 'class')?.local ?? (type && declaresClass(this.text(type)) ? type : undefined)

      if (taken)
        this.error(taken, 'A component with parts takes `class` from its parts', { note: 'its `class` prop is a string for the root or an object with an entry per part, which a plain `class={className}` would render as the words of the part names', help: 'delete the `class` prop: the compiler types it and merges each entry onto its part' })

      if (parts.root === 'none' && script.recipeRoot === true && script.recipeSpan)
        this.error(script.recipeSpan, 'The recipe styles the root, which the template has no part for', { note: 'the template has no single top element and none is marked `part="root"`, so the root classes would go nowhere', help: 'mark the element that is the root with `part="root"`' })
    }

    if (server && script.props)
      this.error(script.props.statement, 'A page declares no props', { note: 'a page gets its data from `--- server`', help: 'read the server names directly' })

    const tags = head?.children.filter((child) => {
      const problem = headTagProblem(child) ?? this.islandHeadProblem(child)

      if (problem)
        this.error(...problem)

      return problem === undefined
    })

    for (const tag of tags ?? []) {
      if (tag.kind === 'element' && tag.name === 'html') {
        this.rootTags.add(tag)
        this.rootAttributes(tag)
      }
    }

    this.nodes(tags ?? [])
    this.nodes(this.file.template.filter(node => !isHead(node)))

    return this.diagnostics
  }

  // `dir` follows the page's language, and `lang` follows the locale under `i18n`, where an `html` tag cannot set it apart from the messages and dates.
  private rootAttributes(tag: ElementNode): void {
    for (const attribute of tag.attributes) {
      if (attribute.kind !== 'spread' && this.text(attribute.name).toLowerCase() === 'dir')
        this.error(attribute.name, `kay sets \`${this.text(attribute.name)}\` on \`<html>\` from the page's language`, { help: 'set `lang` on the page, or in kay.config.ts' })
    }
  }

  // An island renders in the browser too, where it keeps the title alone in step with what it reads.
  private islandHeadProblem(node: Node): [at: Span, message: string] | undefined {
    if (this.options.island !== undefined && node.kind === 'element' && node.name !== 'title')
      return [node.tag, `An island's \`head\` block sets the title only, not \`${node.name}\``]

    return undefined
  }

  // The template's one top-level `head` block.
  private head(nodes: Node[]): ElementNode | undefined {
    let head: ElementNode | undefined

    for (const node of nodes) {
      if (!isHead(node))
        continue

      if (head)
        this.error(node.tag, 'A template has one `head` block', { related: [{ ...head.tag, label: 'the first one' }] })
      else if (node.attributes.length > 0 || node.classes.length > 0 || node.id)
        this.error(node, 'A `head` block takes no attributes')

      head ??= node
    }

    return head
  }

  private nodes(nodes: Node[]): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'element':
          this.element(node)

          break
        case 'text':
          for (const part of node.parts) {
            if (part.kind === 'element')
              this.element(part)
          }

          break
        case 'if':
        case 'match':
          for (const block of childBlocks(node))
            this.nodes(block)

          break
        case 'for':
          this.nodes(node.children)
          this.nodes(node.fallback ?? [])

          break
        case 'await':
          this.nodes(node.pending)
          this.nodes(node.resolved?.children ?? [])
          this.nodes(node.rejected?.children ?? [])

          break
        case 'try':
          this.nodes(node.children)
          this.nodes(node.rejected?.children ?? [])

          break
        case 'slot':
          this.error(node, `\`@${this.text(node.name)}\` must sit directly under a component, to pass it as that component's \`${this.text(node.name)}\` prop`)

          break
        case 'pending':
          if (!this.forms.has(node))
            this.error(node, '`pending` shows while a form posts to an action, so it sits inside one', { help: 'move it into the `form(action={...})` whose post it reports on' })

          this.nodes(node.children)

          break
        case 'error':
          if (!this.forms.has(node))
            this.error(node, '`error` shows the message of a form posting to an action, so it sits inside one', { help: 'move it into the `form(action={...})` whose post it reports on' })

          break
        case 'snippet':
          this.nodes(node.children)

          break
        case 'const':
          break
      }
    }
  }

  private element(element: ElementNode): void {
    const outer = this.foreign

    if (!element.component)
      this.foreign = FOREIGN.has(element.name) || (this.foreign && element.name !== 'foreignObject')

    try {
      this.elementIn(element, outer)
    }
    finally {
      this.foreign = outer
    }
  }

  private elementIn(element: ElementNode, foreign: boolean): void {
    if (this.options.check && !element.component)
      this.accessibility(element)

    if (foreign && !element.component && RAW_TEXT.has(element.name) && this.dynamicContent(element))
      this.error(element.tag, `A \`${element.name}\` inside \`svg\` or \`math\` takes static text only`, { note: `HTML reads its content as markup there, so a value could add elements`, help: `write its text as it is, or move the \`${element.name}\` out of the \`svg\`` })

    if (isHead(element))
      this.error(element, 'A `head` block sits at the top level of a template')

    if (element.name === 'html' && !element.component && !this.rootTags.has(element))
      this.error(element.tag, 'An `html` tag sets the attributes of `<html>` from the `head` block only', { note: 'kay writes `<html>` around every page', help: 'move it into the template\'s top-level `head` block' })

    if (isSlot(element)) {
      if (element.attributes.length > 0 || element.classes.length > 0 || element.id)
        this.error(element, '`slot` takes no attributes', { note: '`slot` marks where a layout or wrapper renders its children, and `slot name` its `name` block prop' })

      this.nodes(element.children)

      return
    }

    this.attributes(element)

    const children = element.children.filter(child => child.kind !== 'slot')
    // Each prop is passed once: by an attribute, by an `@name` block, or for `children` by the lines under the tag.
    const passed = new Map<string, Labelled>(element.attributes.flatMap(attribute => attribute.kind === 'spread' ? [] : [[this.text(attribute.name), { ...attribute.name, label: 'passed by this attribute' }]]))

    if (children.length > 0)
      passed.set('children', { start: children[0]!.start, end: children[0]!.end, label: 'passed by the lines under the tag' })

    for (const slot of element.children) {
      if (slot.kind !== 'slot')
        continue

      if (!element.component) {
        this.nodes([slot])

        continue
      }

      const name = this.text(slot.name)
      const earlier = passed.get(name)

      if (earlier !== undefined)
        this.error(slot.name, `\`${name}\` is passed twice`, { label: 'passed again here', related: [earlier] })

      passed.set(name, { ...slot.name, label: `passed by this \`@${name}\`` })
      this.nodes(slot.children)
    }

    this.nodes(children)
  }

  // Whether what an element holds is computed: a value in its text other than a string literal, any other child, a spread or a content attribute.
  private dynamicContent(element: ElementNode): boolean {
    if (element.attributes.some(attribute => attribute.kind === 'spread' || (attribute.kind === 'expression' && CONTENT_ATTRIBUTES.has(this.text(attribute.name)))))
      return true

    return element.children.some(child => child.kind !== 'text' || child.parts.some(part => part.kind === 'element' || (part.kind === 'expression' && !STRING_LITERAL.test(this.text(part.expression)))))
  }

  private attributes(element: ElementNode): void {
    const serverIsland = serverIslandOf(element, this.src)
    const named = (name: string) => element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && this.text(attribute.name) === name)
    const ids = named('id')

    if (element.id && ids.length > 0)
      this.error(element.id, 'The id is set twice', { label: 'set by `#id`', related: ids.map(attribute => ({ ...attribute.name, label: 'and by this attribute' })) })

    const classAttributes = named('class')
    const classAttribute = classAttributes[0]

    if (classAttributes.length > 1)
      this.error(classAttributes[1]!.name, 'An element takes one `class` attribute', { related: [{ ...classAttribute!.name, label: 'the first one' }], help: 'put several classes in one: `class="a b"`' })

    // The shorthand or a spread merges the `class` attribute in, which takes a value then.
    const merged = element.classes.length > 0 || element.attributes.some(attribute => attribute.kind === 'spread')

    if (merged && classAttribute?.kind === 'boolean')
      this.error(classAttribute.name, '`class` needs a value')

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread' || (merged && attribute === classAttribute) || attribute === serverIsland?.noscript)
        continue

      const name = this.text(attribute.name)

      if (element.component && (this.options.island !== undefined || this.options.insideIsland) && ISLAND_OPTIONS.has(name))
        this.error(attribute.name, `\`${name}\` has no effect inside an island`, { note: 'an island hydrates and lives on as a whole' })

      if (attribute === serverIsland?.attribute)
        this.serverIsland(serverIsland)
      else if (name === FIELD_ATTRIBUTE && !element.component && FIELD_ELEMENTS.has(element.name))
        this.field(element, attribute)
      else
        this.attribute(element, attribute, name)
    }
  }

  // `field` writes `name`, and the constraints of the action's schema, which only a form posting to one has.
  private field(element: ElementNode, attribute: NamedAttribute): void {
    const named = element.attributes.find((other): other is NamedAttribute => other.kind !== 'spread' && this.text(other.name) === 'name')

    if (!this.forms.has(element))
      this.error(attribute.name, '`field` names a field of a form posting to an action, so it sits inside one', { help: 'write `name` for a form posting elsewhere' })
    else if (attribute.kind !== 'static')
      this.error(attribute.name, '`field` takes the field\'s name as written text', { note: 'its constraints are read off the action\'s schema by that name', help: 'write `field="title"`, or `name={...}` for a name computed at render' })
    else if (named)
      this.error(attribute.name, 'A field has `field` or `name`, not both', { related: [{ ...named.name, label: 'named here' }], help: 'drop `name`: `field` writes it' })
  }

  private serverIsland({ attribute, mode, noscript }: ServerIslandMark): void {
    if (this.options.island !== undefined || this.options.insideIsland)
      this.error(attribute.name, '`server` has no effect inside an island', { note: 'an island renders in the browser too, as a whole' })
    else if (mode === undefined)
      this.error(attribute.name, '`server` takes no value, or "defer"', { help: '`server` renders it per request inside the prerendered page, `server="defer"` once the browser fetches it on approach' })
    else if (noscript && mode !== 'defer')
      this.error(noscript.name, '`noscript` only goes with `server="defer"`', { note: 'an inline server island arrives with the page, so it needs no JavaScript' })
    else if (noscript?.kind === 'boolean')
      this.error(noscript.name, '`noscript` takes the text of its link', { help: 'such as `noscript="Show the contact form"`' })
  }

  // Several parts on one component call: the first is the part the call is, the others are parts of this component whose entries it hands on to the called one, each named once and none of them `root`, which a call hands on by being the root.
  private severalParts(element: ElementNode, attribute: Extract<NamedAttribute, { kind: 'static' }>): void {
    const names = attribute.text.trim().split(WHITESPACE)

    if (names.length === 1)
      return

    if (!element.component)
      this.error(attribute.name, 'Only a component call names several parts: `part="root spinner"`', { note: 'the first is the part the call is, the others are parts of this component whose entries it hands on to the called one', help: 'name one part on an element' })
    else if (new Set(names).size !== names.length)
      this.error(attribute.name, 'A part is named once on a call', { help: 'delete the repeated name' })
    else if (names.slice(1).includes('root'))
      this.error(attribute.name, '`root` is the first name of a call that hands parts on, or is not handed', { help: 'write `part="root spinner"`, the root first' })
  }

  private attribute(element: ElementNode, attribute: NamedAttribute, name: string): void {
    if (name === 'part' && (attribute.kind !== 'static' || !attribute.text.trim().split(WHITESPACE).every(part => PART_NAME.test(part))))
      this.error(attribute.name, '`part` names a part with a string: `part="head"`', { note: 'the `class` type of the component is built from the names at compile time', help: 'write a name of letters, digits and dashes' })
    else if (name === 'part' && attribute.kind === 'static')
      this.severalParts(element, attribute)

    if (name === 'transition' || name.startsWith(TRANSITION_PART)) {
      if (element.component)
        this.error(attribute.name, `\`${name}\` animates an element, not a component`, { help: 'set it on the element the component renders, which a prop can carry' })
      else if (name !== 'transition' && !TRANSITION_PARTS.has(name.slice(TRANSITION_PART.length)))
        this.error(attribute.name, `\`${name}\` is no phase of a transition`, { help: 'use `transition:enter`, `transition:enter-from` or `transition:enter-to`, or the same for `leave`' })
    }

    if (!element.component && attribute.kind === 'expression')
      this.lowercaseEvent(attribute, name)

    if (!name.startsWith('bind:'))
      return

    if (attribute.kind !== 'expression') {
      this.error(attribute.name, element.component ? '`bind:` needs a signal or a `Bindable` prop' : '`bind:` needs a signal', { help: element.component ? '`bind:open={open}`' : '`bind:value={name}`' })

      return
    }

    if (element.component) {
      this.componentBind(attribute, name)

      return
    }

    const property = name.slice(5)
    const problem = bindProblem(element, property, this.staticType(element))

    if (problem) {
      this.error(attribute.name, ...problem)

      return
    }

    if (element.attributes.some(candidate => candidate.kind === 'spread')) {
      this.error(attribute.name, `\`bind:${property}\` next to a spread binds nothing`, { note: 'the spread may carry the value and the handler itself, so the element is rendered from its props', help: 'bind on a child element, or write the value and the handler' })

      return
    }

    const event = bindEvent(element, property)
    const handler = element.attributes.find(candidate => candidate.kind !== 'spread' && this.text(candidate.name) === event) as NamedAttribute | undefined

    if (handler)
      this.error(attribute.name, `\`bind:${property}\` already handles \`${event}\``, { related: [{ ...handler.name, label: 'handled here too' }], help: 'drop one of them' })
  }

  // `bind:open={open}` on a component hands it the signal `open` or a `Bindable` prop of the component, named whole or as a member of one.
  private componentBind(attribute: Extract<NamedAttribute, { kind: 'expression' }>, name: string): void {
    const expression = this.text(attribute.expression)
    const [root, ...members] = expression.split('.')

    if (name === 'bind:')
      this.error(attribute.name, '`bind:` names the prop it binds', { help: '`bind:open={open}`' })
    else if (this.restName !== undefined && members.length > 0 && root!.trim() === this.restName)
      this.error(attribute.expression, `\`${expression.trim()}\` is a value, so \`${name}\` has nothing to write`, { help: `spread \`...${this.restName}\` to hand the prop on, or name the prop` })
    else if (!BOUND_NAME.test(expression))
      this.error(attribute.expression, `\`${name}\` needs a signal or a \`Bindable\` prop`, { help: 'name the signal, or the prop of this component, that it writes' })
  }

  // `onclick` and `on:click` attach nothing, and the component would not become an island either.
  private lowercaseEvent(attribute: Extract<Attribute, { kind: 'expression' }>, written: string): void {
    const name = LOWERCASE_EVENT.exec(written)?.[1]

    if (name === undefined)
      return

    const camel = `on${capitalize(name.replace(COMPOUND_EVENT, (_, first: string, second: string) => capitalize(first) + capitalize(second)))}`

    this.error(attribute.name, `\`${written}\` does not attach a handler`, { note: 'events are written in camelCase', help: `\`${camel}\``, fixes: [{ title: `Write \`${camel}\``, edits: [attribute.shorthand ? { ...attribute.shorthand, text: `${camel}={${written}}` } : { ...attribute.name, text: camel }], safe: true }] })
  }

  // Type checking only, so a page still runs while it is fixed. A spread may carry what is missing, so an element with one is left alone.
  private accessibility(element: ElementNode): void {
    if (element.attributes.some(attribute => attribute.kind === 'spread'))
      return

    const names = new Set(element.attributes.map(attribute => this.text((attribute as NamedAttribute).name)))
    // `.card` has no tag of its own to point at.
    const at = element.tag.end > element.tag.start ? element.tag : element
    const required = REQUIRED_TEXT.get(element.name)
    const type = element.attributes.find(attribute => attribute.kind === 'static' && this.text(attribute.name) === 'type')
    const role = element.attributes.find(attribute => this.text((attribute as NamedAttribute).name) === 'role')
    // A role written as an expression may be any; a written one counts when it names a widget.
    const widgetRole = role !== undefined && (role.kind !== 'static' || role.text.trim().toLowerCase().split(WHITESPACE).some(token => WIDGET_ROLES.has(token)))

    if (required && !names.has(required[0]))
      this.lint(at, required[0] === 'alt' ? 'missing-alt' : 'missing-title', required[1], { help: required[2] })

    if (this.unsized(element, names))
      this.lint(at, 'unsized-image', `This \`${element.name}\` has no \`width\` and \`height\`, so the page shifts as it loads`, { help: 'write both, as the image\'s own size: only their ratio matters, CSS sets how large it is drawn; `// kay-allow unsized-image` keeps an image whose box CSS already reserves' })

    if (element.name === 'input' && type?.kind === 'static' && type.text === 'image' && !names.has('alt'))
      this.lint(at, 'missing-alt', 'An image button needs `alt`', { help: 'name what it does' })

    if (!names.has('onClick') || widgetRole || INTERACTIVE_TAGS.has(element.name))
      return

    // A dialog, or an element marked `aria-modal`, is a backdrop whose click is a pointer shortcut for Escape, so it is left alone.
    // A role naming no widget, as a backdrop's `presentation`, was taken as reachable once: a warning, so such apps keep building.
    if (role === undefined)
      this.lint(at, 'unreachable-click', `This \`${element.name}\` reacts to \`onClick\` but is out of reach of the keyboard and screen readers`, { help: 'use a `button`, or give it a widget\'s `role`, such as `button` or `option`, along with a `tabindex` and a key handler; `// kay-allow unreachable-click` keeps a click a keyboard has another way to, such as a backdrop Escape also closes' })
    else if (!this.modal(element) && !(role.kind === 'static' && role.text.trim().toLowerCase().split(WHITESPACE).some(token => token === 'dialog' || token === 'alertdialog')))
      this.lint(at, 'unannounced-click', `This \`${element.name}\` reacts to \`onClick\` but its \`role\` names no widget, so screen readers do not announce it as one`, { help: 'use a `button`, or a widget\'s `role`, such as `button` or `option`; `// kay-allow unannounced-click` keeps a click a keyboard has another way to, such as a backdrop Escape also closes' })
  }

  // `aria-modal` written as an expression may be true, and a written `false` is no backdrop.
  private modal(element: ElementNode): boolean {
    const attribute = element.attributes.find(attribute => this.text((attribute as NamedAttribute).name) === 'aria-modal')

    return attribute !== undefined && !(attribute.kind === 'static' && attribute.text.trim().toLowerCase() === 'false')
  }

  // An `img` or image button that reserves no room for itself. A spread was left alone by the caller, as `image()` gives its size.
  private unsized(element: ElementNode, names: Set<string>): boolean {
    if (names.has('width') && names.has('height'))
      return false

    // Writing either drops the size kay would have written.
    if (names.has('width') || names.has('height'))
      return element.name === 'img' || this.isImageInput(element)

    if (element.name === 'input')
      return this.isImageInput(element)

    if (element.name !== 'img')
      return false

    const src = element.attributes.find(attribute => attribute.kind === 'expression' && this.text(attribute.name) === 'src')

    // An own `srcset` keeps kay from sizing the image.
    if (src?.kind !== 'expression' || names.has('srcset'))
      return true

    const expression = this.text(src.expression).trim()

    return !this.sizedImports.has(expression) && !STORED_URL.test(expression)
  }

  private isImageInput(element: ElementNode): boolean {
    return element.name === 'input' && element.attributes.some(attribute => attribute.kind === 'static' && this.text(attribute.name) === 'type' && attribute.text === 'image')
  }

  // The text of the static `type` of an element, if it has one.
  private staticType(element: ElementNode): string | undefined {
    const type = element.attributes.find(candidate => candidate.kind === 'static' && this.text(candidate.name) === 'type')

    return type?.kind === 'static' ? type.text : undefined
  }

  private text(span: Span): string {
    return this.src.slice(span.start, span.end)
  }

  private error(span: Span, message: string, details?: Details): void {
    this.diagnostics.push({ start: span.start, end: span.end, message, ...details })
  }

  private lint(span: Span, code: LintName, message: string, details?: Details): void {
    this.diagnostics.push({ start: span.start, end: span.end, code, message, ...details, checkOnly: true })
  }
}

function capitalize(word: string): string {
  return `${word[0]!.toUpperCase()}${word.slice(1)}`
}
