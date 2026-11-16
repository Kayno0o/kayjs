import type { Diagnostic } from './ast'
import { allowComments } from './allow-comments'
import { positionAt } from './mapping'

// Lints that no longer exist, whose `// kay-allow` comment is reported by its deprecation instead of as an unknown lint.
export const RETIRED_LINTS: ReadonlySet<string> = new Set(['uncaught-await'])

// A `// kay-allow uncaught-await` comment: an `await` with no `catch` renders the nearest `try`'s `catch`, or an alert, since 1.105, so there is nothing left to allow.
export function retiredAllowComments(source: string): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const comment of allowComments(source)) {
    const index = comment.names.findIndex(({ name }) => name === 'uncaught-await')

    if (index === -1)
      continue

    const { name, start } = comment.names[index]!
    const lineStart = source.lastIndexOf('\n', comment.start - 1) + 1
    const newline = source.indexOf('\n', comment.start)
    const lineEnd = newline === -1 ? source.length : newline
    let edit: { start: number, end: number }

    if (comment.names.length > 1) {
      const next = comment.names[index + 1]

      // The comma after the name goes with it, or the one before the last name.
      edit = next ? { start, end: next.start } : { start: source.lastIndexOf(',', start), end: start + name.length }
    }
    else if (source.slice(lineStart, comment.start).trim() === '') {
      edit = { start: lineStart, end: newline === -1 ? lineEnd : lineEnd + 1 }
    }
    else {
      edit = { start: lineStart + source.slice(lineStart, comment.start).trimEnd().length, end: lineEnd }
    }

    found.push({
      start,
      end: start + name.length,
      code: 'deprecated-uncaught-await',
      checkOnly: true,
      message: `\`uncaught-await\` is gone since 1.105 (line ${positionAt(source, start).line})`,
      help: 'an `await` with no `catch` renders the `catch` of the `try` around it, or an alert, so the comment allows nothing: remove it',
      fixes: [{ title: 'Remove the comment', safe: true, edits: [{ ...edit, text: '' }] }],
    })
  }

  return found
}
