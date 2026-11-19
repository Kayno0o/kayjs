import type { Diagnostic } from './ast'
import { positionAt } from './mapping'
import { REMOVED_LINTS } from './removed-lints'

// What `lints.comments` in kay.config.ts asks of a `// kay-allow` comment: a comment that fails one of these allows nothing and is reported.
export interface AllowRules {
  // A `-- reason` after the names, not empty.
  reason?: boolean | undefined
  // `kay-allow-file` is refused.
  file?: boolean | undefined
  // A lint the config sets to `deny`, by its name or its group, cannot be allowed by a comment.
  denied?: boolean | undefined
}

// A lint's name starts with a letter, so the `--` of a reason is never read as one: `// kay-allow a, b -- why`.
const ALLOW_COMMENT = /\/\/[ \t]*(kay-allow(?:-file)?)[ \t]+(\w[\w-]*(?:[ \t]*,[ \t]*\w[\w-]*)*)([^\n]*)/g
const LINT_NAME = /[\w-]+/g
const REASON = /^[ \t]*--[ \t]*\S/

export interface AllowComment {
  // Each lint it names, with where the name starts.
  names: { name: string, start: number }[]
  file: boolean
  // The line it allows: its own when it ends a line of code, the next when it is alone on its line; unused for a file comment.
  line: number
  // The offset of the comment's `//`, and of the end of what it holds.
  start: number
  end: number
  // Whether a reason follows the names.
  reasoned: boolean
}

export function allowComments(source: string): AllowComment[] {
  return Array.from(source.matchAll(ALLOW_COMMENT), (comment) => {
    const { line, column } = positionAt(source, comment.index)
    const listStart = comment.index + comment[0].length - comment[3]!.length - comment[2]!.length
    const names = Array.from(comment[2]!.matchAll(LINT_NAME), name => ({ name: name[0], start: listStart + name.index }))

    // A comment alone on its line allows the next one; one ending a line of code allows that line.
    return { names, file: comment[1] === 'kay-allow-file', line: source.slice(comment.index - column + 1, comment.index).trim() === '' ? line + 1 : line, start: comment.index, end: comment.index + comment[0].length, reasoned: REASON.test(comment[3]!) }
  })
}

// The names a comment holds that `known` does not know: a lint kay removed is a warning with a fix that drops the name, or the comment (its line when it stands alone) when it was the only one left, and any other name is the error `unknown-lint`.
export function unknownNames(comment: AllowComment, source: string, known: (name: string) => boolean, help: string): Diagnostic[] {
  const unknown = comment.names.filter(({ name }) => !known(name))
  const removed = new Set<string>(REMOVED_LINTS)
  const alone = comment.names.every(({ name }) => removed.has(name))
  const lineStart = source.lastIndexOf('\n', comment.start - 1) + 1
  const whole = source.slice(lineStart, comment.start).trim() === ''
  const after = source[comment.end] === '\n' ? comment.end + 1 : comment.end

  return unknown.map(({ name, start }, index): Diagnostic => {
    const end = start + name.length

    if (!removed.has(name))
      return { start, end, code: 'unknown-lint', message: `Unknown lint \`${name}\``, help, checkOnly: true }

    const position = comment.names.findIndex(other => other.start === start)
    const next = comment.names[position + 1]
    const previous = comment.names[position - 1]
    const span = next ? { start, end: next.start } : { start: previous ? previous.start + previous.name.length : start, end }
    const dropped = whole ? { start: lineStart, end: after } : { start: comment.start, end: comment.end }
    const edit = alone ? dropped : span

    return { start, end, code: 'unknown-lint', severity: 'warning', message: `\`${name}\` is a lint kay has removed`, help: 'remove it from the comment: it allows nothing', checkOnly: true, ...!alone || index === 0 ? { fixes: [{ title: alone ? 'remove the comment' : `remove \`${name}\``, safe: true, edits: [{ ...edit, text: '' }] }] } : {} }
  })
}

// What a comment fails of the rules, as a sentence, or undefined when it holds.
function refusal(comment: AllowComment, rules: AllowRules): string | undefined {
  if (rules.file === true && comment.file)
    return '`kay-allow-file` is refused by `lints.comments`: allow the lint on the line instead'

  if (rules.reason === true && !comment.reasoned)
    return `\`${comment.file ? 'kay-allow-file' : 'kay-allow'}\` needs a reason: \`lints.comments\` asks for \` -- why\` after the names`

  return undefined
}

// The comments that count under the rules.
export function honoured(comments: AllowComment[], rules: AllowRules | undefined): AllowComment[] {
  return rules === undefined ? comments : comments.filter(comment => refusal(comment, rules) === undefined)
}

// A diagnostic for each comment the rules refuse.
export function refusedComments(comments: AllowComment[], rules: AllowRules | undefined): Diagnostic[] {
  if (rules === undefined)
    return []

  return comments.flatMap((comment) => {
    const message = refusal(comment, rules)

    return message === undefined ? [] : [{ start: comment.start, end: comment.start + 2, code: 'allow-refused', message, checkOnly: true }]
  })
}
