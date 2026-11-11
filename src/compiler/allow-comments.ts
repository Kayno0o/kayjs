import type { Diagnostic } from './ast'
import { positionAt } from './mapping'

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
  // The offset of the comment's `//`.
  start: number
  // Whether a reason follows the names.
  reasoned: boolean
}

export function allowComments(source: string): AllowComment[] {
  return Array.from(source.matchAll(ALLOW_COMMENT), (comment) => {
    const { line, column } = positionAt(source, comment.index)
    const listStart = comment.index + comment[0].length - comment[3]!.length - comment[2]!.length
    const names = Array.from(comment[2]!.matchAll(LINT_NAME), name => ({ name: name[0], start: listStart + name.index }))

    // A comment alone on its line allows the next one; one ending a line of code allows that line.
    return { names, file: comment[1] === 'kay-allow-file', line: source.slice(comment.index - column + 1, comment.index).trim() === '' ? line + 1 : line, start: comment.index, reasoned: REASON.test(comment[3]!) }
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
