import type { Attribute, Details, Diagnostic, ElementNode, KayFile, Labelled, NamedAttribute, Node, ServerIslandMark, SlotNode, Span } from './ast'
import type { GenerateOptions } from './codegen'
import type { LintName } from './lints'
import type { PageSettingName } from './page-settings'
import type { ImportBinding, ScriptAnalysis, ServerAnalysis } from './script'
import { RESIZABLE } from '../runtime/image'
import { WIDGET_ROLES } from './aria'
import { childBlocks, EVENT_MODIFIERS, failedBlockOf, FIELD_ATTRIBUTE, FIELD_ELEMENTS, isHead, isSlot, modifiersOf, nodeExpressions, SERVER_IN_ISLAND, serverIslandOf, templateFacts, visitNodes } from './ast'
import { dangerFlags } from './menu-danger'

const UI_SOURCE = /^@kaynooo\/kayjs-ui\/([\w-]+)\.kay$/
const AI_CHAT_SOURCES = new Set(['@kaynooo/kayjs-ai/chat.kay', '@kaynooo/kayjs-ai/chat-launcher.kay'])
// The `file` key `uiComponents` holds for kayjs-ai's Chat.
const AI_CHAT = 'ai-chat'
// Menu's `items` took `danger: true` for a destructive entry until `tone: 'danger'` replaced it, deprecated since 1.92.
const MENU_TAG = 'menu'
// IconPicker's `search(query, limit, offset)` is a function `icons` handed `{ q, limit, offset }` since 1.92.
const ICON_PICKER_TAG = 'icon-picker'
// The kayjs-ui tags whose `onToggle` is `onOpenChange` since 1.90, as every show and hide state reports.
const TOGGLE_TAGS = new Set(['table', 'tree-view'])
// The kayjs-ui tags whose per-day predicate `isDisabled` is `disabledDay` since 1.89.
const DATE_TAGS = new Set(['date-input', 'date-range-input'])
// Widget's `isEmpty` is `empty` and its `@empty` block `@emptyState` since 1.89.
const WIDGET_TAG = 'widget'
// The kayjs-ui props renamed in 1.90 so a failure is named the same everywhere: a message is `failureLabel`, a failed copy `onError`. `onFail` takes its error bare and `onError` an object, so it is reported with no fix.
const FAILURE_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'copy-button': { failure: 'failureLabel', onFail: 'onError' },
  'confirm-delete': { failure: 'failureLabel' },
  'form-dialog': { failure: 'failureLabel' },
  'record-button': { failure: 'failureLabel' },
  'save-form': { failure: 'failureLabel' },
  'audio-player': { failure: 'failureLabel' },
  'icon-picker': { errorLabel: 'failureLabel' },
  'image-cropper': { errorLabel: 'failureLabel' },
  'ai-chat': { errorMessage: 'failureLabel' },
}
// The kayjs-ui callbacks renamed in 1.92 to follow the hook convention (`llms/hooks.md`): `onX` after a transition X in its base form, never a participle. SaveForm is apart, as its own `onSave` was the call that does the save, which `save` is now.
const NO_PARAMETER_FUNCTION = /^\s*(?:async\s+)?(?:\(\s*\)\s*=>|function\s*(?:\w+\s*)?\(\s*\))/

// A name the table holds itself, not one an object inherits (`constructor`, `toString`).
function ownName(table: Readonly<Record<string, Readonly<Record<string, string>>>>, file: string, name: string): string | undefined {
  const row = Object.hasOwn(table, file) ? table[file] : undefined

  return row !== undefined && Object.hasOwn(row, name) ? row[name] : undefined
}

const HOOK_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'form': { onSaved: 'onSave' },
  'form-dialog': { onSaved: 'onSave' },
  'save-form': { onSaved: 'onSave' },
  'contact-form': { onSent: 'onSend' },
  'subscribe-form': { onSent: 'onSend' },
  'audio-player': { onEnded: 'onEnd' },
}
// The kayjs-ui props and blocks that are `actions` since 1.90, where the role is the controls a component holds beside its own: the rest of a Card's title line, a FormField's label line, an AppHeader's far end, a TreeView row's end and a MarkdownEditor's toolbar. A ConfirmDelete's `trigger` string is `triggerLook`, as `trigger` is a block elsewhere.
const ACTIONS_RENAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'card': { head: 'actions' },
  'form-field': { action: 'actions' },
  'app-header': { end: 'actions' },
  'tree-view': { trailing: 'actions' },
  'markdown-editor': { toolbarExtra: 'actions' },
  'confirm-delete': { trigger: 'triggerLook' },
}
// kayjs-ai's Chat and ChatLauncher drew each round button's icon from a block of its own before 1.90; `icons` names them all.
const CHAT_ICON_BLOCKS: Readonly<Record<string, string>> = { sendIcon: 'send', stopIcon: 'stop', newIcon: 'new', attachIcon: 'attach', regenerateIcon: 'regenerate', editIcon: 'edit', recordIcon: 'record', icon: 'open', closeIcon: 'close', expandIcon: 'expand', collapseIcon: 'collapse' }

type ValidateOptions = Pick<GenerateOptions, 'island' | 'insideIsland' | 'check' | 'client' | 'special' | 'includeServer' | 'pageFile' | 'layoutFile' | 'outerSlots' | 'component'>

// The elements each property of an element can be bound to; `group` and `files` also need an input of a type, `radio` or `checkbox` and `file`.
const BINDABLE: ReadonlyMap<string, ReadonlySet<string>> = new Map([['value', new Set(['input', 'textarea', 'select'])], ['checked', new Set(['input', 'textarea', 'select'])], ['group', new Set(['input'])], ['files', new Set(['input'])], ['open', new Set(['details', 'dialog'])]])
const EVENT_NAME = /^on[A-Z]/
const STYLE_PROP = 'style:'
const STYLE_PROPERTY = /^(?:--[\w-]+|-?[a-z][a-z-]*)$/
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
// Utilities of the base breakpoint that give a box its ratio and its sizes: a variant (`sm:`) leaves the base without one.
const ASPECT_CLASS = /^!?aspect-(?!auto!?$)\S/
const WIDTH_CLASS = /^!?(?:w|size)-(?!auto!?$)\S/
const HEIGHT_CLASS = /^!?(?:h|size)-(?!auto!?$)\S/
const ASPECT_STYLE = /(?:^|;)\s*aspect-ratio\s*:\s*(?!auto\s*(?:;|$))\S/i
// `files.url(key)` alone: a stored file's URL holds its size, which kay writes on the `img` showing it, but not once more is joined to it.
const STORED_URL = /^[\w.]+\.url\((?:[^()]|\([^()]*\))*\)$/
const COMPOUND_EVENT = /^(dbl|key|mouse|pointer|touch|drag|focus|context|before|after)(click|down|up|press|move|enter|leave|over|out|start|end|cancel|in|menu|input)$/
const HEAD_TAGS = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'html'])
const HEAD_CONTENT = 'A `head` block holds `title`, `meta`, `link`, `style`, `script`, `base` and `html` elements only'
const QUERY: PageSettingName = 'query'
// A template reading `ctx`, not a member of another object.
const CTX_READ = /(?<![\w$.])ctx\b/
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
  // The names bound to a kayjs-ui component, by the component's file, for `deprecatedUiNames`.
  private uiComponents = new Map<string, string>()
  // The name of the props the script left out of its destructuring: a plain object, whose members are values.
  private restName: string | undefined

  constructor(private readonly file: KayFile, private readonly options: ValidateOptions) {
    this.src = file.source
    this.forms = templateFacts(file).forms
  }

  run(script: ScriptAnalysis, server: ServerAnalysis | undefined): Diagnostic[] {
    this.uiComponents = new Map()

    for (const binding of [...script.imports, ...(server?.imports ?? [])]) {
      const match = binding.imported === 'default' && !binding.typeOnly ? UI_SOURCE.exec(binding.source) : null

      if (match)
        this.uiComponents.set(binding.local, match[1]!)
      else if (binding.imported === 'default' && !binding.typeOnly && AI_CHAT_SOURCES.has(binding.source))
        this.uiComponents.set(binding.local, AI_CHAT)
    }

    this.restName = script.props?.rest && this.text(script.props.rest)
    this.sizedImports = new Set([...script.imports, ...(server?.imports ?? [])].filter(binding => binding.imported === 'default' && !binding.typeOnly && RESIZABLE.test(binding.source)).map(binding => binding.local))

    if (server && this.options.includeServer !== false) {
      for (const [binding, first] of sharedImports(script, server).conflicts)
        this.error(binding.span, `\`${binding.local}\` is imported twice, once in each fence, and not the same way`, { related: [{ ...first.span, label: 'first imported here' }], help: 'import it once' })
    }

    const query = server?.page?.settings.get(QUERY)?.key

    if (query && this.options.special)
      this.error(query, 'Only a page or a layout declares its query', { help: 'read the route\'s query through `ctx.query`' })

    if ((this.options.island !== undefined || this.options.insideIsland === true) && [...script.implicit, ...server?.implicit ?? []].includes('ctx'))
      this.ctxInIsland()

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
    const rest = this.file.template.filter(node => !isHead(node))

    this.blocks(rest)
    this.outlets(server)
    this.nodes(this.rooted() ? rest.filter(node => node.kind !== 'slot') : rest)

    return this.diagnostics
  }

  // `dir` follows the page's language, and `lang` follows the locale under `i18n`, where an `html` tag cannot set it apart from the messages and dates.
  private rootAttributes(tag: ElementNode): void {
    for (const attribute of tag.attributes) {
      if (attribute.kind !== 'spread' && this.text(attribute.name).toLowerCase() === 'dir')
        this.error(attribute.name, `kay sets \`${this.text(attribute.name)}\` on \`<html>\` from the page's language`, { help: 'set `lang` on the page, or in kay.config.ts' })
    }
  }

  // The request values live on the server, where the first render of an island runs, but its hydration in the browser has none.
  private ctxInIsland() {
    let found: Span | undefined

    visitNodes(this.file.template, (node) => {
      found ??= nodeExpressions(node).find(span => CTX_READ.test(this.text(span)))
    })

    if (found)
      this.error(found, '`ctx` is read on the server, which an island, rendering in the browser too, cannot', { help: 'read it in the page or a static component and pass the value in as a prop' })
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

  // Whether the blocks at the root of the template are allowed: in a page or a layout, which only type checking knows of a file compiled alone.
  private rooted(): boolean {
    return this.options.component !== true
  }

  // A layout's `slot name` is a prop of its component beside its server data and `children`, so a name one of those holds would replace it.
  private outlets(server: ServerAnalysis | undefined): void {
    if (this.options.layoutFile !== true)
      return

    const data = new Set(server?.data.map(entry => entry.name))

    visitNodes(this.file.template, (node) => {
      if (node.kind !== 'element' || !node.outlet || node.outlet.args)
        return

      const name = this.text(node.outlet.name)

      if (name === 'children')
        this.error(node.outlet.name, '`slot children` is the layout\'s default slot', { help: 'write `slot` alone for the page, or give the named slot another name' })
      else if (data.has(name))
        this.error(node.outlet.name, `The slot \`${name}\` has the name of the layout's server data`, { note: 'the slot would replace the data in the layout, which could no longer read it', help: 'rename the slot or the data' })
    })
  }

  // The `@name` blocks at the root of a page or a layout, which fill a `slot name` of the layout above: one per name, taking no parameters, and a name some layout above declares once type checking knows them.
  private blocks(nodes: Node[]): void {
    if (!this.rooted())
      return

    const seen = new Set<string>()
    const above = this.options.outerSlots
    const kind = this.options.layoutFile === true ? 'layout' : 'page'

    for (const node of nodes) {
      if (node.kind !== 'slot')
        continue

      const name = this.text(node.name)

      if (this.options.island !== undefined)
        this.error(node.name, `\`@${name}\` cannot sit in a ${kind} that is an island`, { note: 'the block renders once on the server, in the layout, so nothing in it would hydrate', help: 'move what is interactive into a component the block renders' })

      if (node.params)
        this.error(node.params, `\`@${name}\` fills a slot, which takes no parameters`, { help: `write \`@${name}\` alone` })

      if (seen.has(name))
        this.error(node.name, `\`@${name}\` is written twice in this ${kind}`, { help: 'a slot takes one block' })

      seen.add(name)

      if (above !== undefined && this.options.check === true && !above.includes(name))
        this.error(node.name, `No layout above this ${kind} has a \`slot ${name}\``, { note: above.length > 0 ? `the slots of its layouts: ${above.map(slot => `\`${slot}\``).join(', ')}` : 'none of its layouts declares a named slot', help: `write \`slot ${name}\` in the layout that renders it` })

      this.nodes(node.children)
    }
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

    if (this.options.check && element.component) {
      this.deprecatedUiNames(element)
    }

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
        this.serverIsland(serverIsland, failedBlockOf(element, this.src))
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

  private serverIsland({ attribute, mode, noscript }: ServerIslandMark, failed: SlotNode | undefined): void {
    if (this.options.island !== undefined || this.options.insideIsland) {
      this.error(attribute.name, SERVER_IN_ISLAND, { note: 'an island renders in the browser too, as a whole' })
    }
    else if (mode === undefined) {
      this.error(attribute.name, '`server` takes no value, or "defer"', { help: '`server` renders it per request inside the prerendered page, `server="defer"` once the browser fetches it on approach' })
    }
    else if (noscript && mode !== 'defer') {
      this.error(noscript.name, '`noscript` only goes with `server="defer"`', { note: 'an inline server island arrives with the page, so it needs no JavaScript' })
    }
    else if (noscript?.kind === 'boolean') {
      this.error(noscript.name, '`noscript` takes the text of its link', { help: 'such as `noscript="Show the contact form"`' })
    }
    else if (mode !== 'defer' && failed) {
      this.error(failed.name, '`@failed` only goes with `server="defer"`', { note: 'an inline server island arrives with the page, so it cannot fail to load' })
    }
    else if (failed) {
      visitNodes(failed.children, (node) => {
        if (node.kind === 'element' && serverIslandOf(node, this.src) !== undefined)
          this.error(node.tag, '`@failed` holds a server island', { note: 'the block is rendered hidden with the server island, and nothing in it hydrates', help: 'render it outside the block, or leave it out' })
      })
    }
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
    else if (this.options.pageFile === true)
      this.error(attribute.name, 'A page or a layout has no parts to hand on', { note: 'only a component takes `class` entries per part, which a call hands on to the component it calls', help: 'move the call into a component, or name one part' })
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

    if (attribute.kind === 'expression' && attribute.modifiers)
      this.modifiers(element, attribute, name)

    if (name.startsWith(STYLE_PROP))
      this.styleProp(element, attribute, name)

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

    const event = bindEvent(element, property)
    const handler = element.attributes.find(candidate => candidate.kind !== 'spread' && this.text(candidate.name) === event) as NamedAttribute | undefined

    if (handler)
      this.error(attribute.name, `\`bind:${property}\` already handles \`${event}\``, { related: [{ ...handler.name, label: 'handled here too' }], help: 'drop one of them' })
  }

  // `style:color={color()}` sets one property of an element's `style`.
  private styleProp(element: ElementNode, attribute: NamedAttribute, name: string): void {
    if (element.component)
      this.error(attribute.name, '`style:` sets a property of an element, not of a component', { help: 'pass the value as a prop and set it on the element the component renders' })
    else if (attribute.kind !== 'expression')
      this.error(attribute.name, `\`${name}\` takes an expression`, { help: `\`${name}={value}\`, or write the property in \`style\`` })
    else if (!STYLE_PROPERTY.test(name.slice(STYLE_PROP.length)))
      this.error(attribute.name, `\`${name}\` names no CSS property`, { help: 'write it as CSS does: `style:background-color={color}`, or a custom property `style:--gap={gap}`' })
  }

  // `onSubmit|preventDefault={save}` calls the event method first; a handler of an element is the only thing that takes one.
  private modifiers(element: ElementNode, attribute: Extract<NamedAttribute, { kind: 'expression' }>, name: string): void {
    if (element.component || !EVENT_NAME.test(name)) {
      this.error(attribute.modifiers!, 'a modifier belongs to an event handler of an element', { help: '`form(onSubmit|preventDefault={save})`' })

      return
    }

    const seen = new Set<string>()

    for (const modifier of modifiersOf(attribute, this.src)) {
      if (!EVENT_MODIFIERS.has(modifier))
        this.error(attribute.modifiers!, `\`${modifier}\` is no event modifier`, { help: `use ${[...EVENT_MODIFIERS].map(known => `\`|${known}\``).join(' or ')}` })
      else if (seen.has(modifier))
        this.error(attribute.modifiers!, `\`|${modifier}\` is written twice`, { help: 'drop one of them' })

      seen.add(modifier)
    }
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
      this.lint(at, required[0] === 'alt' ? 'missing-alt' : 'missing-title', required[1], { help: required[2], satisfiable: required[0] === 'alt' && this.importedImage(element) })

    if (this.unsized(element, names))
      this.lint(at, 'unsized-image', `This \`${element.name}\` has no \`width\` and \`height\`, so the page shifts as it loads`, { help: 'write both, as the image\'s own size: only their ratio matters, CSS sets how large it is drawn; `// kay-allow unsized-image` keeps an image whose box CSS reserves in a way the lint cannot read, as a bound class' })

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

  // An `img` rendered on the server whose `src` is an imported image: an extension that writes the `alt` into the page as it is served (kayjs-ai's `imageAlt`) can satisfy `missing-alt` for it, which it cannot for one rendered in the browser.
  private importedImage(element: ElementNode): boolean {
    if (element.name !== 'img' || this.options.island !== undefined || this.options.insideIsland === true || this.options.client === true)
      return false

    const src = element.attributes.find(attribute => attribute.kind === 'expression' && this.text(attribute.name) === 'src')

    return src?.kind === 'expression' && this.sizedImports.has(this.text(src.expression).trim())
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

    if (this.reservesBox(element, names))
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

  // Only a static class and `style` are read, as an expression could be anything: an image whose classes are bound is still reported, and `// kay-allow unsized-image` keeps it.
  // The box is reserved by an aspect ratio with a width or a height, written as an attribute or a utility, to derive the other from, or by both sizes written as utilities; `aspect-ratio` in a static `style` counts alone.
  private reservesBox(element: ElementNode, names: Set<string>): boolean {
    const tokens = element.classes.map(span => this.text(span))
    let style = false

    for (const attribute of element.attributes) {
      if (attribute.kind !== 'static')
        continue

      const name = this.text(attribute.name)

      if (name === 'class')
        tokens.push(...attribute.text.split(WHITESPACE))
      else if (name === 'style' && ASPECT_STYLE.test(attribute.text))
        style = true
    }

    const width = names.has('width') || tokens.some(token => WIDTH_CLASS.test(token))
    const height = names.has('height') || tokens.some(token => HEIGHT_CLASS.test(token))

    return style || (tokens.some(token => ASPECT_CLASS.test(token)) && (width || height)) || (width && height)
  }

  private isImageInput(element: ElementNode): boolean {
    return element.name === 'input' && element.attributes.some(attribute => attribute.kind === 'static' && this.text(attribute.name) === 'type' && attribute.text === 'image')
  }

  // The text of the static `type` of an element, if it has one.
  private staticType(element: ElementNode): string | undefined {
    const type = element.attributes.find(candidate => candidate.kind === 'static' && this.text(candidate.name) === 'type')

    return type?.kind === 'static' ? type.text : undefined
  }

  // Type checking only: the kayjs-ui and kayjs-ai props and blocks an app still writes under a name they had before their renames.
  private deprecatedUiNames(element: ElementNode): void {
    const file = this.uiComponents.get(element.name)

    if (file === undefined)
      return

    // A rename is left to the app when the new name is already written, as it would repeat it.
    if (file === WIDGET_TAG) {
      const named = element.children.some(child => child.kind === 'slot' && this.text(child.name) === 'emptyState')

      for (const child of element.children) {
        if (child.kind === 'slot' && this.text(child.name) === 'empty')
          this.lint(child.name, 'deprecated-ui-props', '`@empty` on `Widget` is `@emptyState` since kayjs-ui 1.89, so `empty` alone is the boolean', named ? { help: 'Drop `@empty`, `@emptyState` is there' } : { help: 'Write `@emptyState`', fixes: [{ title: 'Write `@emptyState`', edits: [{ start: child.name.start, end: child.name.end, text: 'emptyState' }], safe: true }] })
      }
    }

    const actionRenames = Object.hasOwn(ACTIONS_RENAMES, file) ? ACTIONS_RENAMES[file] : undefined

    if (actionRenames !== undefined) {
      for (const child of element.children) {
        const old = child.kind === 'slot' ? this.text(child.name) : undefined
        const renamed = old === undefined ? undefined : ownName(ACTIONS_RENAMES, file, old)

        if (child.kind !== 'slot' || old === undefined || renamed === undefined)
          continue

        const named = element.children.some(other => other.kind === 'slot' && this.text(other.name) === renamed) || element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === renamed)

        this.lint(child.name, 'deprecated-ui-actions', `\`@${old}\` on \`${element.name}\` is \`@${renamed}\` since kayjs-ui 1.90, the one name for the controls a component holds`, named ? { help: `Drop \`@${old}\`, \`@${renamed}\` is there` } : { help: `Write \`@${renamed}\``, fixes: [{ title: `Write \`@${renamed}\``, edits: [{ start: child.name.start, end: child.name.end, text: renamed }], safe: true }] })
      }
    }

    if (file === AI_CHAT) {
      for (const child of element.children) {
        const old = child.kind === 'slot' ? this.text(child.name) : undefined
        const icon = old === undefined || !Object.hasOwn(CHAT_ICON_BLOCKS, old) ? undefined : CHAT_ICON_BLOCKS[old]

        if (child.kind === 'slot' && old !== undefined && icon !== undefined)
          this.lint(child.name, 'deprecated-chat-icons', `\`@${old}\` on \`${element.name}\` is \`icons={{ ${icon}: ... }}\` since kayjs-ai 1.90, one prop for every icon`, { help: `Give \`icons={{ ${icon}: <icon> }}\`, an icon of the app's set or one imported from \`~icons/<prefix>/<name>\`` })
      }
    }

    for (const attribute of element.attributes) {
      if (attribute.kind === 'spread')
        continue

      const name = this.text(attribute.name)

      if (file === ICON_PICKER_TAG && name === 'search' && attribute.kind === 'expression') {
        const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === 'icons')
        const wrap = (expression: string) => `({ q, limit, offset }) => (${expression})(q, limit, offset)`
        const edits = attribute.shorthand ? [{ ...attribute.shorthand, text: `icons={${wrap('search')}}` }] : [{ start: attribute.name.start, end: attribute.name.end, text: 'icons' }, { start: attribute.expression.start, end: attribute.expression.end, text: wrap(this.text(attribute.expression).trim()) }]

        this.lint(attribute.name, 'deprecated-icon-picker-search', '`search` on an `IconPicker` is a function `icons` since kayjs-ui 1.92, handed `{ q, limit, offset }`: one prop for a set, a promise and an action', named ? { help: 'Drop `search`, `icons` is there' } : { help: 'Write `icons={({ q, limit, offset }) => ...}`', fixes: [{ title: 'Write `icons`', edits, safe: true }] })

        continue
      }

      if (file === MENU_TAG && name === 'items' && attribute.kind === 'expression') {
        for (const { property, toned } of dangerFlags(this.text(attribute.expression), attribute.expression.start))
          this.lint(property, 'deprecated-menu-danger', '`danger: true` in the `items` of a `Menu` is `tone: \'danger\'`, the one way every component names a meaning', toned ? { help: 'Drop `danger: true`, the `tone` beside it wins' } : { help: 'Write `tone: \'danger\'`', fixes: [{ title: 'Write `tone: \'danger\'`', edits: [{ start: property.start, end: property.end, text: 'tone: \'danger\'' }], safe: true }] })

        continue
      }

      const actionRenamed = ownName(ACTIONS_RENAMES, file, name)

      if (actionRenamed !== undefined) {
        const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === actionRenamed) || element.children.some(other => other.kind === 'slot' && this.text(other.name) === actionRenamed)
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${actionRenamed}={${name}}` } : { start: attribute.name.start, end: attribute.name.end, text: actionRenamed }

        this.lint(attribute.name, 'deprecated-ui-actions', `\`${name}\` on \`${element.name}\` is \`${actionRenamed}\` since kayjs-ui 1.90, the one name for the controls a component holds`, named ? { help: `Drop \`${name}\`, \`${actionRenamed}\` is there` } : { help: `Write \`${actionRenamed}\``, fixes: [{ title: `Write \`${actionRenamed}\``, edits: [edit], safe: true }] })

        continue
      }

      if (file === WIDGET_TAG && name === 'isEmpty') {
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: 'empty={isEmpty}' } : { start: attribute.name.start, end: attribute.name.end, text: 'empty' }

        const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === 'empty')

        this.lint(attribute.name, 'deprecated-ui-props', '`isEmpty` on `Widget` is `empty` since kayjs-ui 1.89, the bare-adjective boolean', named ? { help: 'Drop `isEmpty`, `empty` is there' } : { help: 'Write `empty`', fixes: [{ title: 'Write `empty`', edits: [edit], safe: true }] })

        continue
      }

      if (TOGGLE_TAGS.has(file) && name === 'onToggle') {
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: 'onOpenChange={onToggle}' } : { start: attribute.name.start, end: attribute.name.end, text: 'onOpenChange' }

        const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === 'onOpenChange')

        this.lint(attribute.name, 'deprecated-open-change', `\`onToggle\` on \`${element.name}\` is \`onOpenChange\` since kayjs-ui 1.90, as every show and hide state reports`, named ? { help: 'Drop `onToggle`, `onOpenChange` is there' } : { help: 'Write `onOpenChange`', fixes: [{ title: 'Write `onOpenChange`', edits: [edit], safe: true }] })

        continue
      }

      if (DATE_TAGS.has(file) && name === 'isDisabled') {
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: 'disabledDay={isDisabled}' } : { start: attribute.name.start, end: attribute.name.end, text: 'disabledDay' }

        this.lint(attribute.name, 'deprecated-ui-props', `\`isDisabled\` on \`${element.name}\` is \`disabledDay\` since kayjs-ui 1.89, so \`disabled\` alone is the boolean`, { help: 'Write `disabledDay`', fixes: [{ title: 'Write `disabledDay`', edits: [edit], safe: true }] })

        continue
      }

      const hookRenamed = ownName(HOOK_RENAMES, file, name)
      const saveCall = file === 'save-form' && name === 'onSave'

      if (hookRenamed !== undefined || saveCall) {
        const to = saveCall ? 'save' : hookRenamed!
        const others = new Set(element.attributes.filter(other => other.kind !== 'spread').map(other => this.text(other.name)))
        const spread = element.attributes.some(other => other.kind === 'spread')
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${to}={${name}}` } : { start: attribute.name.start, end: attribute.name.end, text: to }

        // `onSave` of a SaveForm with an `action` hears its result since 1.92, where it replaced the `action`: a function taking no parameter is the old call, which the form no longer makes instead of the action. A reference, or a function reading its parameter, is left alone, as it may be the new hook.
        if (saveCall && others.has('action')) {
          if (attribute.kind === 'expression' && NO_PARAMETER_FUNCTION.test(this.text(attribute.expression)))
            this.lint(attribute.name, 'deprecated-hook-names', `\`onSave\` beside an \`action\` on \`${element.name}\` only hears the action's result since kayjs-ui 1.92: if this was the call that does the save, write it \`save\``, { help: 'If it does the save, write `save` and drop the `action`; if it hears the result, nothing changes' })

          continue
        }

        // Without an `action` (and no spread that may hold one), `onSave` is the call that does the save. The rename changes the component's role: an `on*` attribute makes it an island, `save` leaves it to the build, so the fix is not applied by `kay upgrade`.
        if (saveCall && (spread || others.has('save')))
          continue

        const why = saveCall ? `\`onSave\` on \`${element.name}\` is \`save\` since kayjs-ui 1.92, the call that does the save, where \`onSave\` hears an \`action\`'s result` : `\`${name}\` on \`${element.name}\` is \`${to}\` since kayjs-ui 1.92, so every hook is \`onX\` after a transition, in its base form`
        // `onSaved` beside an `onSave` is renamed once that one is `save`; with a spread the rename may clash with a prop it holds.
        const blocked = !saveCall && (others.has(to) || spread)

        if (blocked) {
          const renameFirst = file === 'save-form' && !others.has('action')
          const clash = renameFirst ? 'Rename `onSave` to `save` first, then write `onSave` here' : `Drop \`${name}\`, \`${to}\` is there`
          const help = others.has(to) ? clash : `Write \`${to}\` by hand: a spread beside it may hold one`

          this.lint(attribute.name, 'deprecated-hook-names', why, { help })
        }
        else {
          this.lint(attribute.name, 'deprecated-hook-names', why, { help: saveCall ? 'Write `save`; the component may then need `--- island`, as an `on*` attribute made it one' : `Write \`${to}\``, fixes: [{ title: `Write \`${to}\``, edits: [edit], safe: !saveCall }] })
        }

        continue
      }

      const renamed = ownName(FAILURE_RENAMES, file, name)

      if (renamed !== undefined) {
        const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === renamed)
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: `${renamed}={${name}}` } : { start: attribute.name.start, end: attribute.name.end, text: renamed }
        const reshaped = name === 'onFail'

        this.lint(attribute.name, 'deprecated-ui-failures', `\`${name}\` on \`${element.name}\` is \`${renamed}\` since kayjs-ui 1.90${reshaped ? ', and `onError` takes `{ error }` where `onFail` took the error' : ''}`, named || reshaped ? { help: reshaped ? 'Write `onError` and read `error` from its argument' : `Drop \`${name}\`, \`${renamed}\` is there` } : { help: `Write \`${renamed}\``, fixes: [{ title: `Write \`${renamed}\``, edits: [edit], safe: true }] })

        continue
      }

      // kayjs-ai's Chat took its upload limit as `maxFileSize` before 1.90.
      if (file === AI_CHAT && name === 'maxFileSize') {
        const named = element.attributes.some(other => other.kind !== 'spread' && this.text(other.name) === 'maxSize')
        const edit = attribute.kind === 'expression' && attribute.shorthand ? { ...attribute.shorthand, text: 'maxSize={maxFileSize}' } : { start: attribute.name.start, end: attribute.name.end, text: 'maxSize' }

        this.lint(attribute.name, 'deprecated-size-limits', '`maxFileSize` of `Chat` is `maxSize` since 1.90, as every size limit is', named ? { help: 'Drop `maxFileSize`, `maxSize` is there' } : { help: 'Write `maxSize`', fixes: [{ title: 'Write `maxSize`', edits: [edit], safe: true }] })
      }
    }
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
