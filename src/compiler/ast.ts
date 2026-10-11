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
    | { kind: 'expression', name: Span, expression: Span }
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
  children: Node[]
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
  // A `when` line's whole value list, which `values` splits; none on an `else`.
  test?: Span | undefined
  alias?: Span | undefined
  values?: Span[] | undefined
  children: Node[]
}

// A `match` is an `if` whose branches compare its subject to each of their values.
export interface IfNode extends Span {
  kind: 'if'
  subject?: Span | undefined
  branches: IfBranch[]
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

export type Node = ElementNode | TextNode | IfNode | ForNode | AwaitNode | TryNode | SlotNode | ConstNode | ErrorNode

// An attribute written with a name, which a spread is not.
export type NamedAttribute = Exclude<Attribute, { kind: 'spread' }>

// `form(action={add})`: the attribute naming the action a form posts to.
export function actionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.component || element.name !== 'form')
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'action')

  return attribute?.kind === 'expression' ? attribute : undefined
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
const UNCHECKED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

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

    if (node.kind === 'if') {
      for (const branch of node.branches) {
        if (branch.test)
          shows(branch.children.find((child): child is ElementNode => child.kind === 'element'), branch.test, loop)
      }
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

// What `aria-describedby` reads while a field, or the form for `''`, is refused, and what it reads otherwise: the error's id after the template's own static value, which then renders through this alone; nothing for a value the template binds.
export function describedByOf(element: ElementNode, source: string, errors: ErrorMessages | undefined, action: Span, field: string): { refused: string, own?: string } | undefined {
  const id = errors?.describing.get(errorKey(source.slice(action.start, action.end), field))
  const own = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'aria-describedby')

  if (id === undefined || (own !== undefined && own.kind !== 'static'))
    return undefined

  return own ? { refused: `${own.text} ${id}`, own: own.text } : { refused: id }
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

export type TemplateHelper = 'For' | 'Show' | 'componentClass'

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
  await: boolean
  try: boolean
  // The shorthand classes of elements and `error` lines, `.card`, as written.
  classes: string[]
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
      return [node.children]
    case 'text':
      return [node.parts.filter(part => part.kind === 'element')]
    case 'if':
      return node.branches.map(branch => branch.children)
    case 'for':
      return [node.children, node.fallback ?? []]
    case 'await':
      return [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []]
    case 'try':
      return [node.children, node.rejected?.children ?? []]
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

// Whether `found` holds for a node of the template, nested ones included.
export function someNode(nodes: readonly Node[], found: (node: Node) => boolean): boolean {
  return nodes.some(node => found(node) || childBlocks(node).some(block => someNode(block, found)))
}
