// Offsets index into the whole .kay source, so every node maps back to the file the user wrote.
export interface Span {
  start: number
  end: number
}

export interface Diagnostic extends Span {
  // What is wrong, short; what to do about it goes in `help`.
  message: string
  // Printed under the span, when the message alone does not say what this part of the line is.
  label?: string | undefined
  // The other places the problem involves, each labelled with its part in it.
  related?: Labelled[] | undefined
  // Why it is a problem, when the message does not say.
  note?: string | undefined
  // What to write instead.
  help?: string | undefined
  // A lint's name, which `kay.config.ts` and a `// kay-allow` comment set the level of; a compile error has none.
  code?: string | undefined
  // A lint at the `warn` level is a warning, reported without failing; anything else is an error.
  severity?: 'error' | 'warning' | undefined
  // What the editor offers to fix it with.
  fixes?: Fix[] | undefined
  // Reported by type checking only: the code generated around it is whole, so the file's type errors still count.
  checkOnly?: boolean | undefined
}

export interface Labelled extends Span {
  label: string
}

// What a diagnostic says besides its message and span.
export type Details = Pick<Diagnostic, 'label' | 'related' | 'note' | 'help' | 'fixes'>

// Edits to the `.kay` source, by offset into it.
export interface Fix {
  title: string
  edits: (Span & { text: string })[]
  // It changes nothing the code means besides the problem it fixes, so `kay check --fix` applies it unasked.
  safe?: boolean
}

export type Attribute
  = | { kind: 'static', name: Span, value: Span, text: string }
    // A bare `{title}` is `title={title}`: its name and its expression are the one span, and `shorthand` holds the braces around it.
    | { kind: 'expression', name: Span, expression: Span, shorthand?: Span }
    | { kind: 'boolean', name: Span }
    | { kind: 'spread', expression: Span }

export interface ElementNode extends Span {
  kind: 'element'
  tag: Span
  name: string
  component: boolean
  classes: Span[]
  id?: Span
  attributes: Attribute[]
  // The `(...)` holding the attributes, brackets included.
  parens?: Span
  // `slot actions` or `slot row(item, i)`: the block prop it renders, and inside the brackets what it calls the block with.
  outlet?: { name: Span, args?: Span | undefined } | undefined
  // A `markdown` block: its lines, from the end of the `markdown` line to the end of the last one, which only `expandMarkdown` reads; it has no children.
  markdown?: Span | undefined
  children: Node[]
  // Attributes the compiler writes itself, as HTML starting with a space: the element a `pending` block stands for.
  fixed?: string | undefined
  // The `pending` block this element stands for, whose form's action an island follows.
  pendingOf?: PendingNode | undefined
}

export interface TextChunk extends Span {
  kind: 'chunk'
  text: string
}

export interface TextExpression extends Span {
  kind: 'expression'
  expression: Span
}

export interface TextNode extends Span {
  kind: 'text'
  parts: (TextChunk | TextExpression | ElementNode)[]
}

export interface IfBranch extends Span {
  test: Span
  alias?: Span | undefined
  children: Node[]
}

// The block an `if` or a `match` renders when no branch takes it.
export interface ElseBlock extends Span {
  children: Node[]
}

export interface IfNode extends Span {
  kind: 'if'
  branches: IfBranch[]
  fallback?: ElseBlock | undefined
}

// A `when` line: its whole value list, which `values` splits at its top-level commas.
export interface MatchCase extends Span {
  test: Span
  values: Span[]
  children: Node[]
}

// The first case one of whose values the subject equals renders.
export interface MatchNode extends Span {
  kind: 'match'
  subject: Span
  cases: MatchCase[]
  fallback?: ElseBlock | undefined
}

export interface ForNode extends Span {
  kind: 'for'
  item: Span
  index?: Span | undefined
  each: Span
  // Without one, rows are matched by the item's `id`, else by the item itself.
  key?: Span | undefined
  children: Node[]
  fallback?: Node[] | undefined
}

export interface SlotNode extends Span {
  kind: 'slot'
  name: Span
  // Inside the brackets of `@row(todo)`: the block is then a function of these parameters.
  params?: Span | undefined
  children: Node[]
}

// `snippet feature(title: string, text: string)`: a function of its parameters returning the lines below it, declared for the lines after it at its indentation and their children, itself included.
export interface SnippetNode extends Span {
  kind: 'snippet'
  name: Span
  // Inside the brackets, as a function's parameters: empty when written without them.
  params: Span
  children: Node[]
}

export interface AwaitBranch extends Span {
  alias?: Span | undefined
  children: Node[]
}

// `await value`, its pending block, then `then name` and `catch error` at the same indentation; `await value then name` has no pending block.
export interface AwaitNode extends Span {
  kind: 'await'
  value: Span
  pending: Node[]
  resolved?: AwaitBranch
  rejected?: AwaitBranch
}

// `try` and its block, then `catch error` at the same indentation: what renders instead once the block throws.
export interface TryNode extends Span {
  kind: 'try'
  children: Node[]
  rejected?: AwaitBranch
}

// `const price = product.cents / 100`: a name for the value, seen by the lines after it at its indentation and by their children.
export interface ConstNode extends Span {
  kind: 'const'
  // A name, or an object or array pattern destructuring the value.
  pattern: Span
  value: Span
}

// `error title` inside a form posting to an action: the message a refused post gives that field, in a `p.error` the field's `aria-describedby` names; a bare `error` shows the form's own.
export interface ErrorNode extends Span {
  kind: 'error'
  // `error.text-sm title`: classes the `p` takes besides `error`.
  classes: Span[]
  // As written, quoted or not; none for the form's own message.
  field?: Span | undefined
  // The field's name, '' for the form's own message.
  name: string
}

// `pending` inside a form posting to an action: what its block holds shows only while that form posts.
export interface PendingNode extends Span {
  kind: 'pending'
  children: Node[]
}

export type Node = ElementNode | TextNode | IfNode | MatchNode | ForNode | AwaitNode | TryNode | SlotNode | SnippetNode | ConstNode | ErrorNode | PendingNode

// An attribute written with a name, which a spread is not.
export type NamedAttribute = Exclude<Attribute, { kind: 'spread' }>

// `form(action={add})`: the attribute naming the action a form posts to.
export function actionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.component || element.name !== 'form')
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'action')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// `a(href="/docs" section)` or `section={active}`: kay's own attribute marking a link current on the pages below it, read by the server markup and never written out.
export function sectionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'boolean' | 'expression' }> | undefined {
  if (element.component)
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'section')

  return attribute?.kind === 'boolean' || attribute?.kind === 'expression' ? attribute : undefined
}

// `Card(server)` renders per request inside a prerendered page, `Card(server="defer")` once the browser fetches it on approach.
export const SERVER_ISLAND_ATTRIBUTE = 'server'
export const SERVER_ISLAND_MODES = new Set(['defer'])
// Beside `server="defer"`, the text of a link to the page with the island in place, for a browser without JavaScript.
export const SERVER_ISLAND_NOSCRIPT = 'noscript'

export interface ServerIslandMark {
  attribute: NamedAttribute
  // Undefined for a value no mode answers to.
  mode: 'inline' | 'defer' | undefined
  noscript: NamedAttribute | undefined
}

// The mark making a component call a server island, with how it renders.
export function serverIslandOf(element: ElementNode, source: string): ServerIslandMark | undefined {
  if (!element.component)
    return undefined

  const named = (name: string) => element.attributes.find((candidate): candidate is NamedAttribute => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === name)
  const attribute = named(SERVER_ISLAND_ATTRIBUTE)

  if (!attribute)
    return undefined

  const noscript = named(SERVER_ISLAND_NOSCRIPT)

  if (attribute.kind === 'boolean')
    return { attribute, mode: 'inline', noscript }

  return { attribute, mode: attribute.kind === 'static' && SERVER_ISLAND_MODES.has(attribute.text) ? attribute.text as 'defer' : undefined, noscript }
}

// Whether an attribute of a component call belongs to its server island mark rather than to its props.
export function marksServerIsland(element: ElementNode, name: string, source: string): boolean {
  if (name === SERVER_ISLAND_ATTRIBUTE)
    return element.component

  return name === SERVER_ISLAND_NOSCRIPT && serverIslandOf(element, source) !== undefined
}

// A key naming the loop's index, as `for row, i of rows key={i}` writes it: rows are matched by their position.
export function keyedByPosition(node: ForNode, source: string): node is ForNode & { index: Span, key: Span } {
  const index = node.index && source.slice(node.index.start, node.index.end)

  return index !== undefined && index !== '' && node.key !== undefined && source.slice(node.key.start, node.key.end).trim() === index
}

// Every element of a template, nested ones included, in source order.
export function* elementsIn(nodes: readonly Node[]): Generator<ElementNode> {
  for (const node of nodes) {
    if (node.kind === 'element')
      yield node

    for (const block of childBlocks(node))
      yield* elementsIn(block)
  }
}

// A field of a form posting to an action: what a refused post fills back in, and whether it can be marked invalid.
export interface FormField {
  name: string
  // Named by `field`, which also writes the constraints the action's schema gives it.
  marked: boolean
  fill?: 'value' | 'checked' | 'content' | 'selected' | undefined
  invalid: boolean
}

export const FIELD_ELEMENTS = new Set(['input', 'textarea', 'select'])
// `input(field="title")` inside `form(action={add})`: `name="title"`, plus the constraints `add`'s schema gives `title`.
export const FIELD_ATTRIBUTE = 'field'
// A password or a file is never sent back; the others post no text the visitor typed.
const UNFILLED_TYPES = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'])

export const UNCHECKED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

// The input types whose role takes no `aria-required`, as the runtime's `UNREQUIRABLE_TYPES`.
export const UNREQUIRABLE_TYPES = new Set(['radio', 'range', 'file', 'color'])

// Only an element whose name and type are written out: the compiler then knows which field it is and how it shows its value.
export function formFieldOf(element: ElementNode, source: string): FormField | undefined {
  if (element.component || !FIELD_ELEMENTS.has(element.name) || element.attributes.some(attribute => attribute.kind === 'spread'))
    return undefined

  const attributes = new Map((element.attributes as NamedAttribute[]).map(attribute => [source.slice(attribute.name.start, attribute.name.end), attribute]))
  const name = attributes.get('name') ?? attributes.get(FIELD_ATTRIBUTE)
  const type = attributes.get('type')

  if (name?.kind !== 'static' || (type !== undefined && type.kind !== 'static'))
    return undefined

  const bound = [...attributes.keys()].some(attribute => attribute.startsWith('bind:'))
  const inputType = type?.text.toLowerCase() ?? 'text'
  const field: FormField = { name: name.text, marked: !attributes.has('name'), invalid: !attributes.has('aria-invalid') && (element.name !== 'input' || !UNCHECKED_TYPES.has(inputType)) }

  // A disabled field posts nothing, so it would come back empty or unticked.
  if (bound || attributes.has('disabled'))
    return field

  if (element.name === 'textarea')
    field.fill = 'content'
  else if (element.name === 'select')
    field.fill = attributes.has('multiple') ? undefined : 'selected'
  else if (inputType === 'checkbox' || inputType === 'radio')
    field.fill = 'checked'
  else if (!UNFILLED_TYPES.has(inputType))
    field.fill = 'value'

  return field
}

// The elements showing an action's errors, and the id each field, or the form for its own message, is described by while refused.
export interface ErrorMessages {
  // Generated ids, for elements with none of their own.
  ids: Map<ElementNode, string>
  // The id of each `error` line, which a loop renders without.
  lines: Map<ErrorNode, string>
  // Keyed by `errorKey`.
  describing: Map<string, string>
}

const ERROR_READ = /^([\w$.]+)\.error\((?:(['"])([^'"]*)\2)?\)$/
const WHITESPACE = /\s+/g
const ID_UNSAFE = /[^\w-]+/g

function errorKey(action: string, field: string): string {
  return `${action.replace(WHITESPACE, '')}\n${field}`
}

function errorId(action: string, field: string): string {
  return `${action.replaceAll('.', '-')}-${field ? `${field.replace(ID_UNSAFE, '-')}-` : ''}error`
}

// An `error` line names the message its field is described by; failing one, as before it, the element `if add.error('title') as message` and `p {add.error('title')}`: the element shown holds the message, outside a `for`, which would repeat its id, for an action a form of the file posts to.
export function errorMessages(nodes: Node[], source: string): ErrorMessages {
  const found: ErrorMessages = { ids: new Map(), lines: new Map(), describing: new Map() }
  const posted = new Set<string>()
  const shown: { element: ElementNode, action: string, field: string }[] = []
  const lines: { node: ErrorNode, action: string }[] = []
  const text = (span: Span) => source.slice(span.start, span.end)

  const shows = (element: ElementNode | undefined, span: Span, loop: boolean) => {
    const match = ERROR_READ.exec(text(span).replace(WHITESPACE, ''))

    if (element && match && !loop && !element.component && !element.attributes.some(attribute => attribute.kind === 'spread'))
      shown.push({ element, action: match[1]!, field: match[3] ?? '' })
  }

  // `form`: the action the form around these nodes posts to.
  walkNodes(nodes, { loop: false, form: undefined as string | undefined }, (node, context) => {
    const { loop, form } = context

    if (node.kind === 'element') {
      const action = actionOf(node, source)
      const posts = action ? text(action.expression).replace(WHITESPACE, '') : undefined

      if (posts !== undefined)
        posted.add(posts)

      for (const child of node.children) {
        if (child.kind === 'text') {
          for (const part of child.parts) {
            if (part.kind === 'expression')
              shows(node, part.expression, loop)
          }
        }
      }

      return { loop, form: posts ?? form }
    }

    if (node.kind === 'if' || node.kind === 'match') {
      for (const branch of node.kind === 'if' ? node.branches : node.cases)
        shows(branch.children.find((child): child is ElementNode => child.kind === 'element'), branch.test, loop)
    }
    else if (node.kind === 'for') {
      return { loop: true, form }
    }
    else if (node.kind === 'error' && form !== undefined && !loop) {
      lines.push({ node, action: form })
    }

    return context
  })

  for (const { node, action } of lines) {
    const key = errorKey(action, node.name)

    if (found.describing.has(key))
      continue

    const id = errorId(action, node.name)

    found.lines.set(node, id)
    found.describing.set(key, id)
  }

  for (const { element, action, field } of shown) {
    const key = errorKey(action, field)
    const own = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && text(attribute.name) === 'id')

    if (!posted.has(action) || found.describing.has(key) || (own !== undefined && own.kind !== 'static'))
      continue

    let id = element.id ? text(element.id) : own?.text

    if (id === undefined) {
      id = errorId(action, field)
      found.ids.set(element, id)
    }

    found.describing.set(key, id)
  }

  return found
}

// The id of the error a refused field, or the form for `''`, is described by, and the template's own static `aria-describedby`, which then renders through this alone; nothing for a value the template binds, or one already naming the error.
export function describedByOf(element: ElementNode, source: string, errors: ErrorMessages | undefined, action: Span, field: string): { id: string, own?: string } | undefined {
  const id = errors?.describing.get(errorKey(source.slice(action.start, action.end), field))
  const own = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'aria-describedby')

  if (id === undefined || (own !== undefined && (own.kind !== 'static' || own.text.split(WHITESPACE).includes(id))))
    return undefined

  return own ? { id, own: own.text } : { id }
}

export function isHead(node: Node): node is ElementNode & { name: 'head' } {
  return node.kind === 'element' && !node.component && node.name === 'head'
}

// `slot` renders the children a layout or wrapper component receives, like Astro's `<slot />`, and `slot name` the block prop of that name; the lines under either render when there is none.
export function isSlot(node: Node): boolean {
  return node.kind === 'element' && node.name === 'slot' && !node.component
}

export function isChildrenSlot(node: Node): boolean {
  return isSlot(node) && (node as ElementNode).outlet === undefined
}

export type TemplateHelper = 'For' | 'componentClass' | 'partClass' | 'partsClass'

// What the template holds that decides the code generated around it, found in one pass and kept on the file, which compiles several times.
export interface TemplateFacts {
  // An element handles events, binds an input or takes a ref.
  interactive: boolean
  // A form posts to an action.
  actionForm: boolean
  helpers: Set<TemplateHelper>
  // The names `await` blocks render as they are, `await comments`.
  awaited: Set<string>
  slot: boolean
  childrenSlot: boolean
  // The template declares a `snippet`.
  snippet: boolean
  await: boolean
  try: boolean
  // The shorthand classes of elements and `error` lines, `.card`, as written.
  classes: string[]
  // The parts the template names, `part="head"`, when it names any.
  parts: PartFacts | undefined
  // The recipe the script declares, whose classes every part of the component takes before its `class`.
  recipe?: string | undefined
  // The action of the form each node sits in, from `formTargets`.
  forms: Map<Node, Span>
  // Whether each attribute expression asked about, by where it starts, is a function: filled as the passes ask, each parsed once.
  functions: Map<number, boolean>
  // The names of the props the script types `Bindable<T>`, which only the script tells: set where the code is generated.
  bindables: ReadonlySet<string>
}

export interface KayFile {
  source: string
  script?: Span | undefined
  server?: Span | undefined
  // Inside the angle brackets of `--- <T extends Row>`: the component function's type parameters.
  typeParameters?: Span | undefined
  // The `client` of `--- client`: the component renders in the browser only.
  client?: Span | undefined
  // Where the template begins, past the fences.
  templateStart: number
  template: Node[]
  diagnostics: Diagnostic[]
  // A `--- server` fence that never closes, which only an `_actions.kay` may leave so: the file name is the compiler's to know.
  unclosedServer?: Diagnostic | undefined
  // Found on first use, once icons are drawn.
  facts?: TemplateFacts | undefined
}

// `Home.size-5`, with `Home` an icon `~icons/...` imports: the `svg` spreading it, as `svg({...Home} class="size-5")` would be written.
export function drawIcons(file: KayFile, icons: ReadonlySet<string>): void {
  file.facts = undefined
  visitNodes(file.template, (node) => {
    if (node.kind === 'element' && node.component && icons.has(node.name)) {
      node.attributes.unshift({ kind: 'spread', expression: node.tag })
      node.name = 'svg'
      node.component = false
      node.tag = { start: node.tag.start, end: node.tag.start }
    }
  })
}

// The node lists right under a node, in source order. Every template walker reaches nested nodes through this one switch, so a new kind of node fails to type-check here until it says what it holds.
export function childBlocks(node: Node): Node[][] {
  switch (node.kind) {
    case 'element':
    case 'slot':
    case 'snippet':
      return [node.children]
    case 'text':
      return [node.parts.filter(part => part.kind === 'element')]
    case 'if':
    case 'match':
      return [...(node.kind === 'if' ? node.branches : node.cases).map(branch => branch.children), ...node.fallback ? [node.fallback.children] : []]
    case 'for':
      return [node.children, node.fallback ?? []]
    case 'await':
      return [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []]
    case 'try':
      return [node.children, node.rejected?.children ?? []]
    case 'pending':
      return [node.children]
    case 'const':
    case 'error':
      return []
  }
}

// Calls `each` on every node of a template, nested ones included, in source order.
export function visitNodes(nodes: readonly Node[], each: (node: Node) => void): void {
  walkNodes(nodes, undefined, each)
}

// Like `visitNodes`, handing each node the context its parent answered for its children.
export function walkNodes<C>(nodes: readonly Node[], context: C, each: (node: Node, context: C) => C): void {
  for (const node of nodes) {
    const inner = each(node, context)

    for (const block of childBlocks(node))
      walkNodes(block, inner, each)
  }
}

// The action of the innermost `form(action={...})` each node sits in; a node outside every such form has none.
export function formTargets(nodes: readonly Node[], source: string): Map<Node, Span> {
  const targets = new Map<Node, Span>()

  walkNodes<Span | undefined>(nodes, undefined, (node, target) => {
    if (target)
      targets.set(node, target)

    return node.kind === 'element' ? actionOf(node, source)?.expression ?? target : target
  })

  return targets
}

// Whether `found` holds for a node of the template, nested ones included.
export function someNode(nodes: readonly Node[], found: (node: Node) => boolean): boolean {
  return nodes.some(node => found(node) || childBlocks(node).some(block => someNode(block, found)))
}

export const INTERACTIVE_ATTRIBUTE = /^(?:on[A-Z]|bind:|ref$)/
const IDENTIFIER = /^[A-Z_$][\w$]*$/i

// The parts a template names with `part="head"`, which a component's `class` prop reaches by name.
export interface PartFacts {
  // Each part, with the component it is a call of when it is one: its class is then that component's own.
  names: Map<string, (string | undefined)[]>
  // Where the string form of `class` goes: the part marked `root`, else the template's single top element, else nowhere.
  root: 'marked' | 'implicit' | 'none'
  implicit?: ElementNode | undefined
  // The file is a component, whose props carry `class`; a page or a layout only renders `data-part`.
  merges: boolean
}

const ANY_WHITESPACE = /\s+/g

// Whether the expression of a `bind:` is a prop of this component typed `Bindable<T>`, which it passes on as it reads and writes it, rather than a signal.
export function bindsOwnProp(facts: TemplateFacts, expression: string): boolean {
  return facts.bindables.has(expression.replaceAll(ANY_WHITESPACE, ''))
}

// The attribute that names a part, when it is written as a plain string.
export function partAttribute(element: ElementNode, source: string): Extract<NamedAttribute, { kind: 'static' }> | undefined {
  return element.attributes.find((attribute): attribute is Extract<NamedAttribute, { kind: 'static' }> => attribute.kind === 'static' && source.slice(attribute.name.start, attribute.name.end) === 'part')
}

export function partName(element: ElementNode, source: string): string | undefined {
  const text = partAttribute(element, source)?.text

  return text === undefined || text === '' ? undefined : text
}

// The parts an element answers for in a component: the one it names, and `root` when it is the single top element.
export function partsOf(element: ElementNode, source: string, parts: PartFacts | undefined): string[] {
  if (!parts?.merges)
    return []

  const named = partName(element, source)

  return [...named === undefined ? [] : [named], ...element === parts.implicit && named !== 'root' ? ['root'] : []]
}

function markRoot(parts: PartFacts, template: Node[]): void {
  if (parts.names.has('root')) {
    parts.root = 'marked'

    return
  }

  const top = template.filter(node => !isHead(node) && node.kind !== 'const' && node.kind !== 'snippet')
  const only = top.length === 1 ? top[0] : undefined

  if (only?.kind === 'element' && !isSlot(only)) {
    parts.root = 'implicit'
    parts.implicit = only
    parts.names.set('root', [only.component ? only.name : undefined])
  }
}

// What every output and check of a file reads off its template, found once and kept on the file: `recipe` is the name of the script's recipe, which the template alone cannot tell.
export function templateFacts(file: KayFile, recipe?: string): TemplateFacts {
  const facts = file.facts ??= factsOf(file)

  if (recipe !== undefined && facts.recipe === undefined)
    addRecipe(facts, file, recipe)

  return facts
}

// A component with a recipe has parts even when its template marks none: its root is the single top element.
function addRecipe(facts: TemplateFacts, file: KayFile, recipe: string): void {
  facts.recipe = recipe

  if (!facts.parts) {
    facts.parts = { names: new Map(), root: 'none', merges: true }
    markRoot(facts.parts, file.template)

    if (facts.parts.root !== 'none')
      facts.helpers.add('partClass')

    if (facts.parts.implicit?.component)
      facts.helpers.add('partsClass')
  }
}

function factsOf(file: KayFile): TemplateFacts {
  const facts: TemplateFacts = { interactive: false, actionForm: false, helpers: new Set(), awaited: new Set(), slot: false, childrenSlot: false, snippet: false, await: false, try: false, classes: [], parts: undefined, forms: formTargets(file.template, file.source), functions: new Map(), bindables: new Set() }
  const text = (span: Span) => file.source.slice(span.start, span.end)

  visitNodes(file.template, (node) => {
    if (node.kind === 'element') {
      facts.interactive ||= node.attributes.some(attribute => attribute.kind !== 'spread' && INTERACTIVE_ATTRIBUTE.test(text(attribute.name)))
      facts.actionForm ||= actionOf(node, file.source) !== undefined
      facts.slot ||= isSlot(node)
      facts.childrenSlot ||= isChildrenSlot(node)
      facts.classes.push(...node.classes.map(text))

      if (mergesComponentClass(node, file.source))
        facts.helpers.add('componentClass')

      const part = partName(node, file.source)

      if (part !== undefined) {
        facts.parts ??= { names: new Map(), root: 'none', merges: true }
        const tag = node.component ? node.name : undefined
        const tags = facts.parts.names.get(part) ?? []

        if (!tags.includes(tag))
          facts.parts.names.set(part, [...tags, tag])

        facts.helpers.add('partClass')

        if (node.component)
          facts.helpers.add('partsClass')
      }
    }
    else if (node.kind === 'snippet') {
      facts.snippet = true
    }
    else if (node.kind === 'for') {
      facts.helpers.add('For')
    }
    else if (node.kind === 'await') {
      const value = text(node.value).trim()

      facts.await = true

      if (IDENTIFIER.test(value))
        facts.awaited.add(value)
    }
    else if (node.kind === 'try') {
      facts.try = true
    }
    else if (node.kind === 'error') {
      facts.classes.push(...node.classes.map(text))
    }
  })

  if (facts.parts) {
    markRoot(facts.parts, file.template)

    if (facts.parts.implicit?.component)
      facts.helpers.add('partsClass')
  }

  return facts
}

// A component call whose `class` merges several parts, which it gets as one string: a shorthand with a `class` expression, or a spread next to a shorthand or a `class`.
function mergesComponentClass(element: ElementNode, source: string): boolean {
  if (!element.component)
    return false

  const attribute = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'class')

  if (element.attributes.some(attribute => attribute.kind === 'spread'))
    return element.classes.length > 0 || attribute !== undefined

  // A shorthand beside a static `class` merges while rendering, as the browser's build resolves it while compiling.
  return element.classes.length > 0 && attribute !== undefined
}

// The spans of a template written in JavaScript, which is all of it a linter can judge: attribute values and spreads, `{...}` in text, the heads of `if`, `match`, `for`, `await`, `const` and `slot`. Tags, classes, static values and text stay with kay.
export function expressionSpans(nodes: readonly Node[]): Span[] {
  const spans: Span[] = []

  visitNodes(nodes, node => spans.push(...nodeExpressions(node)))

  return spans
}

// The spans of a node's own heads and values in JavaScript, those of its children left out.
export function nodeExpressions(node: Node): Span[] {
  const spans: Span[] = []

  switch (node.kind) {
    case 'element':
      for (const attribute of node.attributes) {
        if (attribute.kind === 'expression' || attribute.kind === 'spread')
          spans.push(attribute.expression)
      }

      if (node.outlet?.args)
        spans.push(node.outlet.args)

      break
    case 'text':
      for (const part of node.parts) {
        if (part.kind === 'expression')
          spans.push(part.expression)
      }

      break
    case 'if':
      spans.push(...node.branches.map(branch => branch.test))

      break
    case 'match':
      spans.push(node.subject, ...node.cases.flatMap(branch => branch.values))

      break
    case 'for':
      spans.push(node.each)

      if (node.key)
        spans.push(node.key)

      break
    case 'await':
      spans.push(node.value)

      break
    case 'slot':
      if (node.params)
        spans.push(node.params)

      break
    case 'snippet':
      spans.push(node.params)

      break
    case 'const':
      spans.push(node.pattern, node.value)

      break
    case 'try':
    case 'error':
    case 'pending':
      break
  }

  return spans
}
