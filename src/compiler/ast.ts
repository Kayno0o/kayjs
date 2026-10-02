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

export type Node = ElementNode | TextNode | IfNode | ForNode | SlotNode

export interface KayFile {
  source: string
  script?: Span
  template: Node[]
  diagnostics: Diagnostic[]
}
