// Offsets index into the whole .kay source, so every node maps back to the file the user wrote.
export interface Span {
  start: number
  end: number
}

export interface Diagnostic extends Span {
  message: string
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

export type Node = ElementNode | TextNode | IfNode | ForNode | AwaitNode | SlotNode

// The pending, resolved and failed blocks, in source order.
export function awaitBlocks(node: AwaitNode): Node[][] {
  return [node.pending, node.resolved?.children ?? [], node.rejected?.children ?? []]
}

export interface KayFile {
  source: string
  script?: Span
  server?: Span
  // Where the template begins, past the fences.
  templateStart: number
  template: Node[]
  diagnostics: Diagnostic[]
}
