import type { ShadowFile } from '../check/shadow'
// `kay/eslint`: lints the JavaScript of .kay files, the script and server fences and the template's expressions, through the TSX `kay check` type-checks them as, reporting at the .kay line.
import type { Span } from '../compiler/ast'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { version } from '../../package.json'
import { classEdit, classSpan } from '../check/class-words'
import { codeEdit, compileShadow, inFences, readShadowSettings, shadowPath, sourceSpan } from '../check/shadow'
import { offsetAt, positionAt } from '../compiler/mapping'
import { projectRootOf } from '../project'

export interface LintFix {
  range: [number, number]
  text: string
}

export interface LintMessage {
  ruleId: string | null
  message: string
  line: number
  column: number
  endLine?: number | undefined
  endColumn?: number | undefined
  fatal?: boolean | undefined
  fix?: LintFix | undefined
  suggestions?: { desc: string, fix: LintFix }[] | undefined
}

export interface ParserOptions {
  filePath?: string
  project?: unknown
  projectService?: unknown
}

const BLOCK = 'kay.tsx'
// How long the editor's lint waits on `kay types` before giving up on it rather than hang.
const TYPES_TIMEOUT = 60_000
// The classes of a template are written into the TSX as strings of their own, which only the rules about classes judge: any other rule on one would report the generated string.
const TAILWIND_RULE = /^better-tailwindcss\//
// What ESLint names the block `preprocess` returns: the .kay file's path, then `<index>_kay.tsx`.
const BLOCK_PATH = /^(.+\.kay)[/\\]\d+_kay\.tsx$/

// The code the generated function wraps a fence in sits one level deeper than the fence is written, so the rules about indentation read the fence's lines indented by it.
const LEVEL = '  '

// What the processor handed ESLint for a file: the shadow, and the offsets in its code where a fence's line is indented one level further in the text ESLint reads.
interface Linted {
  shadow: ShadowFile
  text: string
  indented: number[]
  lines: Set<number>
}

// Lint runs each file through preprocess then postprocess before the next, so this only ever holds the one being linted.
const compiled = new Map<string, Linted>()

// ESLint keys its cache on `meta.name@meta.version`, so a kay upgrade that adds findings re-lints every .kay file.
export const processor = {
  meta: { name: 'kay', version },
  supportsAutofix: true,

  preprocess(text: string, filename: string): { text: string, filename: string }[] {
    const file = resolve(filename)
    const root = projectRootOf(file)
    const settings = readShadowSettings(root)
    const { shadow } = compileShadow(root, file, text, { routesDir: settings.routesDir, mounts: settings.mounts, insideIsland: settings.islandOnly.has(file), lints: settings.lints })

    const indented = shadow.bodyLines ?? []

    const shifted = indentLines(shadow.tsx, indented)

    compiled.set(filename, { shadow, text: shifted, indented, lines: new Set(indented) })

    return [{ text: shifted, filename: BLOCK }]
  },

  // Only what is reported in the author's own JavaScript, and by the rules about classes in the template's classes, stands: the rest of the TSX is generated, and its problems are kay check's to report.
  postprocess(messages: LintMessage[][], filename: string): LintMessage[] {
    const entry = compiled.get(filename)!

    compiled.delete(filename)

    const seen = new Set<string>()

    // The compiler copies some expressions twice, `bind:value={x}` for its read and its write, so one finding is reported at one place twice.
    return messages.flat().flatMap(message => mapMessage(entry, message) ?? []).sort((a, b) => a.line - b.line || a.column - b.column).filter((message) => {
      const key = JSON.stringify([message.ruleId, message.message, message.line, message.column, message.endLine, message.endColumn])

      if (seen.has(key))
        return false

      seen.add(key)

      return true
    })
  },
}

// Roots whose `kay types` failed, so a broken config or a missing `bun` costs one run per ESLint process, not one per file.
const typesFailed = new Set<string>()

// Runs `kay types` for a project whose types nothing wrote yet, as in an editor's ESLint on a fresh app, and tells whether it did: this is a Node bundle, so Bun runs the project's own kay as a child.
function writeTypes(root: string): boolean {
  if (typesFailed.has(root))
    return false

  try {
    // `kay/package.json` is not exported, so kay is found from `kay/eslint`, the file ESLint loaded this from.
    let kay = dirname(createRequire(join(root, 'package.json')).resolve('kay/eslint'))

    while (!existsSync(join(kay, 'package.json')))
      kay = dirname(kay)

    if (spawnSync('bun', [join(kay, 'src/cli.ts'), 'types', root, '--quiet'], { stdio: 'ignore', timeout: TYPES_TIMEOUT }).status === 0)
      return true
  }
  catch {}

  typesFailed.add(root)

  return false
}

// Points typescript-eslint at the shadow file `kay check` writes for the .kay file being linted, which the project's tsconfig includes, so type-aware rules see the whole project.
export function shadowParser<Options extends ParserOptions, Result>(parser: { parseForESLint: (code: string, options: Options) => Result }): { meta: { name: string, version: string }, parseForESLint: (code: string, options: Options) => Result } {
  return {
    meta: { name: 'kay/shadow-parser', version },
    parseForESLint(code, options) {
      const match = BLOCK_PATH.exec(options.filePath ?? '')

      if (!match)
        return parser.parseForESLint(code, options)

      const file = match[1]!
      const root = projectRootOf(file)
      const shadow = shadowPath(root, file)

      if ((Boolean(options.project) || Boolean(options.projectService)) && !existsSync(shadow) && !writeTypes(root))
        throw new Error(`${relative(root, file)} has no type information yet: run kay check, or kay dev, before linting it`)

      return parser.parseForESLint(code, { ...options, filePath: shadow })
    },
  }
}

const ARROW_PARENS = /(?:^|\/)arrow-parens$/
const SLOT_HEAD_OPEN = /@[\w-]+\($/
const COMPILED_PROPS = /\b__props\./g
const HORIZONTAL_SPACE = /^[ \t]*/
const LINE_END = /^(?:\r?\n|$)/
const INDENT_RULE = /(?:^|\/)indent$/
const MIXED_RULE = /(?:^|\/)no-mixed-spaces-and-tabs$/
const NON_BLANK = /\S/
const NON_BLANK_OR_END = /\S|$/
const SPACE = /\s/
const INDENTATION = /^[ \t]*$/
const LINE_COMMENT = /\/\/.*$/
// A line starting with a character that opens a statement rather than closes one.
const STATEMENT_START = /[^\s)\]}]/
const PLAIN_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

// A slot's one plain parameter, `@about(text)`: kay writes it bare in the shadow, so a rule about the parentheses around it would report, and fix, text the .kay file holds as the slot's own syntax.
function slotParameter(source: string, span: { start: number, end: number }): boolean {
  return source[span.end] === ')' && SLOT_HEAD_OPEN.test(source.slice(0, span.start)) && PLAIN_NAME.test(source.slice(span.start, span.end))
}

function indentLines(text: string, indented: number[]): string {
  let result = ''
  let cursor = 0

  for (const at of indented) {
    result += text.slice(cursor, at) + LEVEL
    cursor = at
  }

  return result + text.slice(cursor)
}

// An offset in the text ESLint read, back in the code the shadow generated: one inside the indentation added stands at the start of its line.
function unindented(indented: number[], offset: number): number {
  let removed = 0

  for (const [index, line] of indented.entries()) {
    const at = line + index * LEVEL.length

    if (offset <= at)
      break

    removed += Math.min(offset - at, LEVEL.length)
  }

  return offset - removed
}

// A fix as the shadow's code would take it: its range back in that code, and the lines it writes in a fence one level shallower.
function unindentedFix(linted: Linted, fix: LintFix): LintFix {
  const { indented, text } = linted
  const { tsx } = linted.shadow
  const start = unindented(indented, fix.range[0])
  const range: [number, number] = [start, unindented(indented, fix.range[1])]
  const line = lineStart(tsx, start)

  if (!linted.lines.has(line))
    return { range, text: fix.text }

  const lines = fix.text.split('\n')
  // The line the text ends on goes on as the line of the code that follows it.
  const following = text.slice(fix.range[1], lineEnd(text, fix.range[1]))
  const opens = fix.range[0] < line + (indented.indexOf(line) + 1) * LEVEL.length

  return { range, text: lines.map((written, index) => (index === 0 ? opens : NON_BLANK.test(written) || (index === lines.length - 1 && NON_BLANK.test(following))) && written.startsWith(LEVEL) ? written.slice(LEVEL.length) : written).join('\n') }
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

function lineEnd(text: string, offset: number): number {
  const end = text.indexOf('\n', offset)

  return end === -1 ? text.length : end
}

// Whether a line of the generated code reads other than the line of the file it was copied from: a name in it was rewritten, which moves what follows it.
function rewritten(shadow: ShadowFile, line: number): boolean {
  const from = shadow.map.isExact(line) ? shadow.map.toSource(line) : undefined

  if (from === undefined)
    return true

  return shadow.tsx.slice(line, lineEnd(shadow.tsx, line)).trimEnd() !== shadow.source.slice(from, lineEnd(shadow.source, from)).trimEnd()
}

// What the scan of a statement knows of an open bracket.
interface Bracket {
  call: boolean
  // The line the bracket opens on, and whether the first argument starts there too: the arguments after it that start a line are aligned to its column.
  line: number
  aligned: boolean
  arguments: number
  pending: boolean
  locked: boolean
}

// Whether the line is aligned, by the rules about indentation, to a column that a rewrite moved: it starts an argument, or sits in one, after the first of a call whose first argument follows rewritten code on its line. The rules align such an argument to the call's first one by column, so they would misjudge the line and their fix misalign it.
function alignedAfterRewrite(linted: Linted, line: number): boolean {
  const { indented } = linted
  const { tsx } = linted.shadow
  let head = indented.indexOf(line)

  if (head === -1)
    return false

  // The statement the line belongs to starts at the last line before it that is not indented.
  while (head > 0 && !STATEMENT_START.test(tsx[indented[head]!]!))
    head--

  const brackets: Bracket[] = []
  const first = line + tsx.slice(line).search(NON_BLANK_OR_END)
  let quote: string | undefined

  for (let at = indented[head]!; at < first; at++) {
    const character = tsx[at]!
    const top = brackets.at(-1)

    if (quote !== undefined) {
      if (character === '\\')
        at++
      else if (character === quote)
        quote = undefined

      continue
    }

    if (character === '/' && tsx[at + 1] === '/') {
      at = tsx.indexOf('\n', at)

      if (at === -1)
        break

      continue
    }

    if (character === '/' && tsx[at + 1] === '*') {
      at = tsx.indexOf('*/', at + 2)

      if (at === -1)
        break

      continue
    }

    if (SPACE.test(character))
      continue

    // The first character of an argument, which a comma or the opening parenthesis announced.
    if (top?.pending) {
      top.pending = false
      top.locked = top.arguments > 0 && top.aligned && INDENTATION.test(tsx.slice(lineStart(tsx, at), at))
    }

    if (character === '"' || character === '\'' || character === '`') {
      quote = character
    }
    else if (character === '(' || character === '[' || character === '{') {
      const call = character === '('
      const opened = lineStart(tsx, at)

      brackets.push({ call, line: opened, aligned: call && NON_BLANK.test(tsx.slice(at + 1, lineEnd(tsx, at)).replace(LINE_COMMENT, '')), arguments: 0, pending: call, locked: false })
    }
    else if (character === ')' || character === ']' || character === '}') {
      brackets.pop()
    }
    else if (character === ',' && top?.call) {
      top.arguments++
      top.pending = true
      top.locked = false
    }
  }

  // The line itself may start an argument.
  const open = brackets.at(-1)

  if (open?.pending)
    open.locked = open.arguments > 0 && open.aligned && !')]}'.includes(tsx[first] ?? ')')

  return brackets.some(bracket => bracket.call && bracket.locked && rewritten(linted.shadow, bracket.line))
}

// The findings that would be false: the indentation rules outside a fence, whose lines the generated code lays out as it likes, and after a rewrite; and a tab the added indentation now follows.
function misjudged(linted: Linted, ruleId: string | null, offset: number, span: Span): boolean {
  const line = lineStart(linted.shadow.tsx, offset)

  if (INDENT_RULE.test(ruleId ?? ''))
    return !inFences(linted.shadow, span.start, span.start) || alignedAfterRewrite(linted, line)

  return MIXED_RULE.test(ruleId ?? '') && linted.lines.has(line) && linted.shadow.tsx[line] === '\t'
}

function mapMessage(linted: Linted, message: LintMessage): LintMessage | undefined {
  const entry = linted.shadow
  const tailwind = TAILWIND_RULE.test(message.ruleId ?? '')
  const position = (line: number, column: number) => unindented(linted.indented, offsetAt(linted.text, { line, column }))
  // A parser that throws, as the shadow parser does without a shadow file, reports no line, or line 0.
  const start = message.line >= 1 ? position(message.line, message.column) : undefined
  const end = message.endLine === undefined || message.endColumn === undefined ? undefined : position(message.endLine, message.endColumn)
  const span = start === undefined ? undefined : sourceSpan(entry, start, end ?? start, 'code') ?? (tailwind ? classSpan(entry, start, end ?? start + 1) : undefined)

  // A file that does not parse would otherwise pass: kay check names the reason at its line, this only keeps lint from passing.
  if (!span)
    return message.fatal ? { ...message, line: 1, column: 1, endLine: undefined, endColumn: undefined } : undefined

  if (ARROW_PARENS.test(message.ruleId ?? '') && slotParameter(entry.source, span))
    return undefined

  if (start !== undefined && misjudged(linted, message.ruleId, start, span))
    return undefined

  const endPosition = end === undefined ? undefined : positionAt(entry.source, span.end)
  // Props compile to `__props.name`, in a fence as in the template, so a message or fix quoting that code is put back to what the .kay file wrote, unless the file writes `__props` itself.
  const named = entry.source.includes('__props') ? (text: string) => text : (text: string) => text.replaceAll(COMPILED_PROPS, '')
  const fix = message.fix && mapFix(entry, unindentedFix(linted, message.fix), tailwind)
  const suggestions = message.suggestions?.flatMap((suggestion) => {
    const mappedFix = mapFix(entry, unindentedFix(linted, suggestion.fix), tailwind)

    return mappedFix ? [{ ...suggestion, desc: named(suggestion.desc), fix: { ...mappedFix, text: named(mappedFix.text) } }] : []
  })

  return { ...message, message: named(message.message), ...positionAt(entry.source, span.start), endLine: endPosition?.line, endColumn: endPosition?.column, fix: fix && { ...fix, text: named(fix.text) }, suggestions }
}

// A fix stands only when the code it replaces was copied verbatim from the .kay file, or is a class the template writes as the string joins it, and a line break it adds only in a fence: a template expression is one line of the file.
function mapFix(entry: ShadowFile, fix: LintFix, classes: boolean): LintFix | undefined {
  const span = codeEdit(entry, fix.range[0], fix.range[1])

  if (!span) {
    const edit = classes ? classEdit(entry, fix.range[0], fix.range[1], fix.text) : undefined

    return edit && { range: [edit.start, edit.end], text: edit.text }
  }

  if (!fix.text.includes('\n'))
    return { range: [span.start, span.end], text: fix.text }

  if (!inFences(entry, span.start, span.end))
    return undefined

  return fix.text.endsWith('\n') ? lineBroken(entry.source, span, fix.text) : { range: [span.start, span.end], text: fix.text }
}

// A fix ending on a line break that code follows indents it as the line it breaks, and takes the space that followed the break; a bare blank line is left as it is.
function lineBroken(source: string, span: { start: number, end: number }, text: string): LintFix {
  const lineStart = source.lastIndexOf('\n', span.start - 1) + 1
  const indent = HORIZONTAL_SPACE.exec(source.slice(lineStart))![0]
  const following = HORIZONTAL_SPACE.exec(source.slice(span.end))![0]

  if (LINE_END.test(source.slice(span.end + following.length)))
    return { range: [span.start, span.end], text }

  return { range: [span.start, span.end + following.length], text: text + indent }
}
