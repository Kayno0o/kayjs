import type { Attribute, Details, Diagnostic, ElementNode, KayFile, Labelled, NamedAttribute, Node, ServerIslandMark, Span } from './ast'
import type { GenerateOptions } from './codegen'
import type { LintName } from './lints'
import type { PageSettingName } from './page-settings'
import type { ImportBinding, ScriptAnalysis, ServerAnalysis } from './script'
import { RESIZABLE } from '../runtime/image'
import { LOCALE_ATTRIBUTES } from '../runtime/root'
import { WIDGET_ROLES } from './aria'
import { childBlocks, FIELD_ATTRIBUTE, FIELD_ELEMENTS, isHead, isSlot, serverIslandOf, templateFacts } from './ast'
import { millisecondsText } from './duration-text'

type ValidateOptions = Pick<GenerateOptions, 'island' | 'insideIsland' | 'check' | 'special' | 'includeServer'>

const UI_SOURCE = /^@kaynooo\/kayjs-ui\/([\w-]+)\.kay$/

interface UiRule {
  prop: string
  // Set when only one literal value is old.
  value?: string
  // The attribute, or for a value rule the whole attribute, that replaces it; left out when the change is not mechanical.
  to?: string
  // Set when the old form is a number literal of milliseconds in `{}`, and the new one the duration string it stands for.
  milliseconds?: true
  // Another attribute that makes the change unsafe to write for the app.
  blockedBy?: string[]
  note: string
  help: string
}

const OPEN_CHANGE: UiRule = { prop: 'onToggle', to: 'onOpenChange', note: 'every disclosure takes `onOpenChange(open)`', help: 'Write `onOpenChange`' }
const EMPTY: UiRule = { prop: 'empty', to: 'emptyLabel', note: '`emptyLabel` names the no-data text', help: 'Write `emptyLabel`' }
const CLOSE: UiRule = { prop: 'onClose', note: '`onOpenChange(open)` is called with `false` on close', help: 'write `onOpenChange={open => ...}`, whose argument is the new state, instead of a handler for the close event' }
const BUTTON: UiRule[] = [
  { prop: 'variant', value: 'default', to: 'variant="solid"', note: '`default` is `solid`', help: 'Write `variant="solid"`' },
  { prop: 'variant', value: 'accent', to: 'tone="accent"', blockedBy: ['tone'], note: '`variant` names the form and `tone` the meaning', help: 'Write `tone="accent"`' },
  { prop: 'variant', value: 'danger', to: 'tone="danger"', blockedBy: ['tone'], note: '`variant` names the form and `tone` the meaning', help: 'Write `tone="danger"`' },
]

// By the component's file in kayjs-ui.
const UI_RULES = new Map<string, UiRule[]>([
  ['dialog', [CLOSE]],
  ['side-panel', [CLOSE]],
  ['form-dialog', [{ ...CLOSE, to: 'onOpenChange', note: '`onOpenChange(open)` replaces `onClose`' }]],
  ['popover', [OPEN_CHANGE]],
  ['button', BUTTON],
  ['copy-button', BUTTON],
  ['icon-button', [BUTTON[2]!]],
  ['menu', [{ prop: 'variant', value: 'danger', to: 'variant="solid" tone="danger"', blockedBy: ['tone'], note: '`variant` names the form and `tone` the meaning', help: 'Write `variant="solid" tone="danger"`' }]],
  ['confirm-delete', [{ prop: 'variant', value: 'danger', to: 'variant="solid"', blockedBy: ['tone'], note: '`variant` names the icon trigger\'s form and the `tone` of the confirmation its meaning', help: 'Write `variant="solid"`' }]],
  ['notice', [{ prop: 'tone', value: 'error', to: 'tone="danger"', note: '`error` is `danger`', help: 'Write `tone="danger"`' }]],
  ['bar-list', [EMPTY]],
  ['media-gallery', [EMPTY]],
  ['scatter-chart', [EMPTY]],
  ['carousel', [{ prop: 'autoplay', milliseconds: true, note: 'a bare number is milliseconds for now, and `autoplay` takes a duration', help: 'Write the duration as a string' }]],
])

const BINDABLE = new Set(['input', 'textarea', 'select'])
const TRANSITION_PART = 'transition:'
const TRANSITION_PARTS = new Set(['enter', 'enter-from', 'enter-to', 'leave', 'leave-from', 'leave-to'])
const LOWERCASE_EVENT = /^on:?([a-z]+)$/
const WHITESPACE = /\s+/
// `files.url(key)`: a stored file's URL holds its size, which kay writes on the `img` showing it.
const STORED_URL = /^[\w.]+\.url\(/
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

// Why `bind:` cannot bind this property of this element, or nothing when it can.
export function bindProblem(element: ElementNode, property: string): [message: string, details: Details] | undefined {
  if (element.component || !BINDABLE.has(element.name))
    return ['`bind:` works on <input>, <textarea> and <select> only', { help: 'pass a component a value and a setter' }]

  if (property !== 'value' && property !== 'checked')
    return [`\`bind:${property}\` is not supported`, { help: 'use `bind:value` or `bind:checked`' }]

  return undefined
}

// The event `bind:` writes the signal back from.
export function bindEvent(element: ElementNode, property: string): string {
  return property === 'checked' || element.name === 'select' ? 'onChange' : 'onInput'
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
  // The names bound to a kayjs-ui component with an old form `deprecated-ui-prop` knows, by the component's file.
  private uiComponents = new Map<string, string>()

  constructor(private readonly file: KayFile, private readonly options: ValidateOptions) {
    this.src = file.source
    this.forms = templateFacts(file).forms
  }

  run(script: ScriptAnalysis, server: ServerAnalysis | undefined): Diagnostic[] {
    this.uiComponents = new Map()

    for (const binding of [...script.imports, ...(server?.imports ?? [])]) {
      const match = binding.imported === 'default' && !binding.typeOnly ? UI_SOURCE.exec(binding.source) : null

      if (match && UI_RULES.has(match[1]!))
        this.uiComponents.set(binding.local, match[1]!)
    }

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

  // `lang` and `dir` follow the page's locale, which an `html` tag cannot set apart from its messages and dates.
  private rootAttributes(tag: ElementNode): void {
    for (const attribute of tag.attributes) {
      if (attribute.kind !== 'spread' && LOCALE_ATTRIBUTES.has(this.text(attribute.name).toLowerCase()))
        this.error(attribute.name, `kay sets \`${this.text(attribute.name)}\` on \`<html>\` from the page's locale`, { help: 'set `lang` in kay.config.ts, or the locales of `i18n`' })
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
        case 'error':
          if (!this.forms.has(node))
            this.error(node, '`error` shows the message of a form posting to an action, so it sits inside one', { help: 'move it into the `form(action={...})` whose post it reports on' })

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

    if (this.options.check && element.component)
      this.deprecatedUiProps(element)

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

  private attribute(element: ElementNode, attribute: NamedAttribute, name: string): void {
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
      this.error(attribute.name, '`bind:` needs a signal', { help: '`bind:value={name}`' })

      return
    }

    const property = name.slice(5)
    const problem = bindProblem(element, property)

    if (problem) {
      this.error(attribute.name, ...problem)

      return
    }

    const event = bindEvent(element, property)
    const handler = element.attributes.find(candidate => candidate.kind !== 'spread' && this.text(candidate.name) === event) as NamedAttribute | undefined

    if (handler)
      this.error(attribute.name, `\`bind:${property}\` already handles \`${event}\``, { related: [{ ...handler.name, label: 'handled here too' }], help: 'drop one of them' })
  }

  // `onclick` and `on:click` attach nothing, and the component would not become an island either.
  private lowercaseEvent(attribute: Extract<Attribute, { kind: 'expression' }>, written: string): void {
    const name = LOWERCASE_EVENT.exec(written)?.[1]

    if (name === undefined)
      return

    const camel = `on${capitalize(name.replace(COMPOUND_EVENT, (_, first: string, second: string) => capitalize(first) + capitalize(second)))}`

    this.error(attribute.name, `\`${written}\` does not attach a handler`, { note: 'events are written in camelCase', help: `\`${camel}\``, fixes: [{ title: `Write \`${camel}\``, edits: [{ ...attribute.name, text: camel }], safe: true }] })
  }

  // Past the quote or the brace that closes the attribute's value.
  private attributeEnd(attribute: Exclude<Attribute, { kind: 'spread' }>): number {
    if (attribute.kind === 'boolean')
      return attribute.name.end

    const tail = attribute.kind === 'static' ? attribute.value.end : attribute.expression.end
    const closing = attribute.kind === 'static' ? '"\'' : '}'

    return closing.includes(this.src[tail] ?? ' ') ? tail + 1 : tail
  }

  // Type checking only. A prop kayjs-ui renamed keeps working as an alias, so the old form is a warning with a fix when the new form takes the same value.
  private deprecatedUiProps(element: ElementNode): void {
    const rules = UI_RULES.get(this.uiComponents.get(element.name) ?? '')

    if (!rules)
      return

    const written = (name: string) => element.attributes.find(attribute => attribute.kind !== 'spread' && this.text(attribute.name) === name)

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread')
        continue

      const name = this.text(attribute.name)
      const whole = { start: attribute.name.start, end: this.attributeEnd(attribute) }
      const milliseconds = attribute.kind === 'expression' ? millisecondsText(Number(this.text(attribute.expression))) : undefined
      const rule = rules.find(candidate => candidate.prop === name && (candidate.milliseconds ? milliseconds !== undefined : candidate.value === undefined || (attribute.kind === 'static' && attribute.text === candidate.value)))

      if (!rule)
        continue

      if (rule.milliseconds) {
        const help = `Write ${name}="${milliseconds!}"`

        this.lint(whole, 'deprecated-ui-prop', `\`${name}\` on \`${element.name}\` is the form kayjs-ui replaced in 1.52: ${rule.note}`, { help, fixes: [{ title: help, edits: [{ ...whole, text: `${name}="${milliseconds!}"` }], safe: true }] })

        continue
      }

      const blocked = rule.blockedBy?.some(other => written(other)) ?? false
      const edits = rule.to === undefined || blocked || (rule.value === undefined && written(rule.to)) ? undefined : [rule.value === undefined ? { ...attribute.name, text: rule.to } : { ...whole, text: rule.to }]
      const shown = rule.value === undefined ? `\`${name}\`` : `\`${name}="${rule.value}"\``

      this.lint(whole, 'deprecated-ui-prop', `${shown} on \`${element.name}\` is the form kayjs-ui replaced in 1.52: ${rule.note}`, { help: rule.help, fixes: edits ? [{ title: rule.help, edits, safe: true }] : undefined })
    }
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

    // A role naming no widget, as a backdrop's `presentation`, was taken as reachable once: a warning, so such apps keep building.
    if (role === undefined)
      this.lint(at, 'unreachable-click', `This \`${element.name}\` reacts to \`onClick\` but is out of reach of the keyboard and screen readers`, { help: 'use a `button`, or give it a widget\'s `role`, such as `button` or `option`, along with a `tabindex` and a key handler; `// kay-allow unreachable-click` keeps a click a keyboard has another way to, such as a backdrop Escape also closes' })
    else
      this.lint(at, 'unannounced-click', `This \`${element.name}\` reacts to \`onClick\` but its \`role\` names no widget, so screen readers do not announce it as one`, { help: 'use a `button`, or a widget\'s `role`, such as `button` or `option`; `// kay-allow unannounced-click` keeps a click a keyboard has another way to, such as a backdrop Escape also closes' })
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
