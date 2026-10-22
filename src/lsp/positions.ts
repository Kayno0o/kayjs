import type { Position } from './protocol'
import { offsetAt, positionAt } from '../compiler/mapping'

// LSP positions are 0-based, the mapping helpers 1-based; both count UTF-16 code units like JS strings.
export function toOffset(text: string, position: Position): number {
  return Math.min(offsetAt(text, { line: position.line + 1, column: position.character + 1 }), text.length)
}

export function toPosition(text: string, offset: number): Position {
  const { line, column } = positionAt(text, offset)

  return { line: line - 1, character: column - 1 }
}
