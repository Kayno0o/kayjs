// `kay/eslint`: lints the script and server fences of .kay files through the TSX `kay check` type-checks them as, reporting at the .kay line.
import type { Span } from '../compiler/ast'
import type { SourceMap } from '../compiler/mapping'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { TSCONFIG } from '../build/files'
import { compileShadow, readShadowSettings, shadowPath } from '../check/shadow'
import { offsetAt, positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'

export interface LintFix {
  range: [number, number]
  text: string
}

export interface LintMessage {
  ruleId: string | null
  message: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  fatal?: boolean
  fix?: LintFix
  suggestions?: { desc: string, fix: LintFix }[]
}

export interface ParserOptions {
  filePath?: string
  project?: unknown
  projectService?: unknown
}

interface Compiled {
  source: string
  tsx: string
  map: SourceMap
  fences: Span[]
}

const BLOCK = 'kay.tsx'
// What ESLint names the block `preprocess` returns: the .kay file's path, then `<index>_kay.tsx`.
const BLOCK_PATH = /^(.+\.kay)[/\\]\d+_kay\.tsx$/

// Lint runs each file through preprocess then postprocess before the next, so this only ever holds the one being linted.
const compiled = new Map<string, Compiled>()

export const processor = {
  meta: { name: 'kay' },
  supportsAutofix: true,

  preprocess(text: string, filename: string): { text: string, filename: string }[] {
    const file = resolve(filename)
    const root = projectRoot(file)
    const settings = readShadowSettings(root)
    const { shadow } = compileShadow(root, settings.routesDir, file, text, settings.islandOnly.has(file))
    const parsed = parseKay(text)

    compiled.set(filename, { source: text, tsx: shadow.tsx, map: shadow.map, fences: [parsed.script, parsed.server].filter(span => span !== undefined) })

    return [{ text: shadow.tsx, filename: BLOCK }]
  },

  // Only what is reported in the fences' own code stands: the rest of the TSX is generated, and its problems are kay check's to report.
  postprocess(messages: LintMessage[][], filename: string): LintMessage[] {
    const entry = compiled.get(filename)!

    compiled.delete(filename)

    return messages.flat().flatMap(message => mapMessage(entry, message) ?? [])
  },
}

// Points typescript-eslint at the shadow file `kay check` writes for the .kay file being linted, which the project's tsconfig includes, so type-aware rules see the whole project.
export function shadowParser<Options extends ParserOptions, Result>(parser: { parseForESLint: (code: string, options: Options) => Result }): { meta: { name: string }, parseForESLint: (code: string, options: Options) => Result } {
  return {
    meta: { name: 'kay/shadow-parser' },
    parseForESLint(code, options) {
      const match = BLOCK_PATH.exec(options.filePath ?? '')

      if (!match)
        return parser.parseForESLint(code, options)

      const file = match[1]!
      const root = projectRoot(file)
      const shadow = shadowPath(root, file)

      if ((Boolean(options.project) || Boolean(options.projectService)) && !existsSync(shadow))
        throw new Error(`${relative(root, file)} has no type information yet: run kay check, or kay dev, before linting it`)

      return parser.parseForESLint(code, { ...options, filePath: shadow })
    },
  }
}

function mapMessage(entry: Compiled, message: LintMessage): LintMessage | undefined {
  // A parser that throws, as the shadow parser does without a shadow file, reports no line, or line 0.
  const start = message.line >= 1 ? offsetAt(entry.tsx, { line: message.line, column: message.column }) : undefined
  const source = start !== undefined && entry.map.isExact(start) ? entry.map.toSource(start) : undefined

  // A copied run maps its end too, which is where generated code follows it, such as the `;` after a fence's last statement.
  if (start === undefined || source === undefined || entry.tsx[start] !== entry.source[source] || !entry.fences.some(fence => source >= fence.start && source <= fence.end)) {
    // A file that does not parse would otherwise pass: kay check names the reason at its line, this only keeps lint from passing.
    return message.fatal ? { ...message, line: 1, column: 1, endLine: undefined, endColumn: undefined } : undefined
  }

  const end = message.endLine === undefined || message.endColumn === undefined ? undefined : offsetAt(entry.tsx, { line: message.endLine, column: message.endColumn })
  const sourceEnd = end !== undefined && entry.map.isExact(end) ? entry.map.toSource(end) : undefined
  const endPosition = sourceEnd === undefined ? undefined : positionAt(entry.source, sourceEnd)
  const fix = message.fix && mapFix(entry, message.fix)
  const suggestions = message.suggestions?.flatMap((suggestion) => {
    const mappedFix = mapFix(entry, suggestion.fix)

    return mappedFix ? [{ ...suggestion, fix: mappedFix }] : []
  })

  return { ...message, ...positionAt(entry.source, source), endLine: endPosition?.line, endColumn: endPosition?.column, fix, suggestions }
}

// A fix stands only when the fence code it replaces was copied verbatim from the .kay file.
function mapFix(entry: Compiled, fix: LintFix): LintFix | undefined {
  const span = entry.map.toSourceSpan(fix.range[0], fix.range[1])

  return span && entry.fences.some(fence => span.start >= fence.start && span.end <= fence.end) ? { range: [span.start, span.end], text: fix.text } : undefined
}

// The project a file belongs to, as the LSP finds it: the nearest directory holding a tsconfig.json, which is where `kay check` runs.
function projectRoot(file: string): string {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, TSCONFIG)))
      return dir
  }

  return dirname(file)
}
