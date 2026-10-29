import type { CallExpression } from 'oxc-parser'
import type { Parsed } from '../compiler/estree'
import { parseProgram } from '../compiler/estree'

const SPACE = /\s/

export interface Insert { at: number, text: string }

// The module's syntax tree, or nothing for a source that does not parse, which its caller leaves as it is.
export function parseModule(source: string, jsx: boolean): Parsed | undefined {
  try {
    return parseProgram(source, { lang: jsx ? 'tsx' : 'ts' })
  }
  catch {
    return undefined
  }
}

// Where a call's last argument ends: after its last token, parentheses and a trailing comma included, before any comment closing the call.
export function argumentsEnd(source: string, ast: Parsed, call: CallExpression): number {
  const { comments } = ast
  let at = call.end - 1

  for (let moved = true; moved;) {
    moved = false

    while (at > 0 && SPACE.test(source[at - 1]!))
      at--

    const comment = comments.find(found => found.end === at)

    if (comment) {
      at = comment.start
      moved = true
    }
  }

  return at
}

export function applyInserts(source: string, inserts: Insert[]): string {
  let result = source

  for (const { at, text } of inserts.sort((a, b) => b.at - a.at))
    result = result.slice(0, at) + text + result.slice(at)

  return result
}
