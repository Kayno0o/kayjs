// `kay/eslint`: lints the JavaScript of .kay files, the script and server fences and the template's expressions, through the TSX `kay check` type-checks them as, reporting at the .kay line.
import type { ShadowFile } from '../check/shadow'
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

// Lint runs each file through preprocess then postprocess before the next, so this only ever holds the one being linted.
const compiled = new Map<string, ShadowFile>()

// ESLint keys its cache on `meta.name@meta.version`, so a kay upgrade that adds findings re-lints every .kay file.
export const processor = {
  meta: { name: 'kay', version },
  supportsAutofix: true,

  preprocess(text: string, filename: string): { text: string, filename: string }[] {
    const file = resolve(filename)
    const root = projectRootOf(file)
    const settings = readShadowSettings(root)
    const { shadow } = compileShadow(root, file, text, { routesDir: settings.routesDir, mounts: settings.mounts, insideIsland: settings.islandOnly.has(file), lints: settings.lints })

    compiled.set(filename, shadow)

    return [{ text: shadow.tsx, filename: BLOCK }]
  },

  // Only what is reported in the author's own JavaScript, and by the rules about classes in the template's classes, stands: the rest of the TSX is generated, and its problems are kay check's to report.
  postprocess(messages: LintMessage[][], filename: string): LintMessage[] {
    const entry = compiled.get(filename)!

    compiled.delete(filename)

    const seen = new Set<string>()

    // The compiler copies some expressions twice, `bind:value={x}` for its read and its write, so one finding is reported at one place twice.
    return messages.flat().flatMap(message => mapMessage(entry, message) ?? []).filter((message) => {
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
const PLAIN_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u

// A slot's one plain parameter, `@about(text)`: kay writes it bare in the shadow, so a rule about the parentheses around it would report, and fix, text the .kay file holds as the slot's own syntax.
function slotParameter(source: string, span: { start: number, end: number }): boolean {
  return source[span.end] === ')' && SLOT_HEAD_OPEN.test(source.slice(0, span.start)) && PLAIN_NAME.test(source.slice(span.start, span.end))
}

function mapMessage(entry: ShadowFile, message: LintMessage): LintMessage | undefined {
  const tailwind = TAILWIND_RULE.test(message.ruleId ?? '')
  // A parser that throws, as the shadow parser does without a shadow file, reports no line, or line 0.
  const start = message.line >= 1 ? offsetAt(entry.tsx, { line: message.line, column: message.column }) : undefined
  const end = message.endLine === undefined || message.endColumn === undefined ? undefined : offsetAt(entry.tsx, { line: message.endLine, column: message.endColumn })
  const span = start === undefined ? undefined : sourceSpan(entry, start, end ?? start, 'code') ?? (tailwind ? classSpan(entry, start, end ?? start + 1) : undefined)

  // A file that does not parse would otherwise pass: kay check names the reason at its line, this only keeps lint from passing.
  if (!span)
    return message.fatal ? { ...message, line: 1, column: 1, endLine: undefined, endColumn: undefined } : undefined

  if (ARROW_PARENS.test(message.ruleId ?? '') && slotParameter(entry.source, span))
    return undefined

  const endPosition = end === undefined ? undefined : positionAt(entry.source, span.end)
  // Props compile to `__props.name`, in a fence as in the template, so a message or fix quoting that code is put back to what the .kay file wrote, unless the file writes `__props` itself.
  const named = entry.source.includes('__props') ? (text: string) => text : (text: string) => text.replaceAll(COMPILED_PROPS, '')
  const fix = message.fix && mapFix(entry, message.fix, tailwind)
  const suggestions = message.suggestions?.flatMap((suggestion) => {
    const mappedFix = mapFix(entry, suggestion.fix, tailwind)

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

  if ((/^(?:\r?\n|$)/).test(source.slice(span.end + following.length)))
    return { range: [span.start, span.end], text }

  return { range: [span.start, span.end + following.length], text: text + indent }
}
