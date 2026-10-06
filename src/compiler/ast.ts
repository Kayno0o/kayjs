// Offsets index into the whole .kay source, so every node maps back to the file the user wrote.
export interface Span {
  start: number
  end: number
}

export interface Diagnostic extends Span {
  message: string
  // What the editor offers to fix it with.
  fixes?: Fix[]
  // Reported by type checking only: the code generated around it is whole, so the file's type errors still count.
  checkOnly?: boolean
}

// Edits to the `.kay` source, by offset into it.
export interface Fix {
  title: string
  edits: (Span & { text: string })[]
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
  test?: Span
  alias?: Span
  children: Node[]
}

export interface IfNode extends Span {
  kind: 'if'
  branches: IfBranch[]
}

export interface ForNode extends Span {
  kind: 'for'
  item: Span
  index?: Span
  each: Span
  key: Span
  children: Node[]
  fallback?: Node[]
}

export interface SlotNode extends Span {
  kind: 'slot'
  name: Span
  // Inside the brackets of `@row(todo)`: the block is then a function of these parameters.
  params?: Span
  children: Node[]
}

export interface AwaitBranch extends Span {
  alias?: Span
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

export type Node = ElementNode | TextNode | IfNode | ForNode | AwaitNode | TryNode | SlotNode

// An attribute written with a name, which a spread is not.
export type NamedAttribute = Exclude<Attribute, { kind: 'spread' }>

// `form(action={add})`: the attribute naming the action a form posts to.
export function actionOf(element: ElementNode, source: string): Extract<Attribute, { kind: 'expression' }> | undefined {
  if (element.component || element.name !== 'form')
    return undefined

  const attribute = element.attributes.find(candidate => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'action')

  return attribute?.kind === 'expression' ? attribute : undefined
}

// A field of a form posting to an action: what a refused post fills back in, and whether it can be marked invalid.
export interface FormField {
  name: string
  fill?: 'value' | 'checked' | 'content' | 'selected'
  invalid: boolean
}

const FIELD_ELEMENTS = new Set(['input', 'textarea', 'select'])
// A password or a file is never sent back; the others post no text the visitor typed.
const UNFILLED_TYPES = new Set(['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'])
const UNCHECKED_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])

// Only an element whose name and type are written out: the compiler then knows which field it is and how it shows its value.
export function formFieldOf(element: ElementNode, source: string): FormField | undefined {
  if (element.component || !FIELD_ELEMENTS.has(element.name) || element.attributes.some(attribute => attribute.kind === 'spread'))
    return undefined

  const attributes = new Map((element.attributes as NamedAttribute[]).map(attribute => [source.slice(attribute.name.start, attribute.name.end), attribute]))
  const name = attributes.get('name')
  const type = attributes.get('type')

  if (name?.kind !== 'static' || (type !== undefined && type.kind !== 'static'))
    return undefined

  const bound = [...attributes.keys()].some(attribute => attribute.startsWith('bind:'))
  const inputType = type?.text.toLowerCase() ?? 'text'
  const field: FormField = { name: name.text, invalid: !attributes.has('aria-invalid') && (element.name !== 'input' || !UNCHECKED_TYPES.has(inputType)) }

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

export function isHead(node: Node): node is ElementNode & { name: 'head' } {
  return node.kind === 'element' && !node.component && node.name === 'head'
}

// `slot` renders the children a layout or wrapper component receives, like Astro's `<slot />`.
export function isChildrenSlot(node: Node): boolean {
  return node.kind === 'element' && node.name === 'slot' && !node.component
}

// The pending, resolved and failed blocks, in source order.
export function awaitBlocks(node: AwaitNode): Node[][] {
  return [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []]
}

// The block and its `catch` block, in source order.
export function tryBlocks(node: TryNode): Node[][] {
  return [node.children, node.rejected?.children ?? []]
}

export interface KayFile {
  source: string
  script?: Span
  server?: Span
  // Inside the angle brackets of `--- <T extends Row>`: the component function's type parameters.
  typeParameters?: Span
  // The `client` of `--- client`: the component renders in the browser only.
  client?: Span
  // Where the template begins, past the fences.
  templateStart: number
  template: Node[]
  diagnostics: Diagnostic[]
}
