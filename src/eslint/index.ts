// `kay/eslint`: lints the script and server fences of .kay files through the TSX `kay check` type-checks them as, reporting at the .kay line.
import type { ShadowFile } from '../check/shadow'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { compileShadow, fenceEdit, readShadowSettings, shadowPath, sourceSpan } from '../check/shadow'
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
// What ESLint names the block `preprocess` returns: the .kay file's path, then `<index>_kay.tsx`.
const BLOCK_PATH = /^(.+\.kay)[/\\]\d+_kay\.tsx$/

// Lint runs each file through preprocess then postprocess before the next, so this only ever holds the one being linted.
const compiled = new Map<string, ShadowFile>()

export const processor = {
  meta: { name: 'kay' },
  supportsAutofix: true,

  preprocess(text: string, filename: string): { text: string, filename: string }[] {
    const file = resolve(filename)
    const root = projectRootOf(file)
    const settings = readShadowSettings(root)
    const { shadow } = compileShadow(root, settings.routesDir, file, text, settings.islandOnly.has(file), settings.lints)

    compiled.set(filename, shadow)

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
      const root = projectRootOf(file)
      const shadow = shadowPath(root, file)

      if ((Boolean(options.project) || Boolean(options.projectService)) && !existsSync(shadow))
        throw new Error(`${relative(root, file)} has no type information yet: run kay check, or kay dev, before linting it`)

      return parser.parseForESLint(code, { ...options, filePath: shadow })
    },
  }
}

function mapMessage(entry: ShadowFile, message: LintMessage): LintMessage | undefined {
  // A parser that throws, as the shadow parser does without a shadow file, reports no line, or line 0.
  const start = message.line >= 1 ? offsetAt(entry.tsx, { line: message.line, column: message.column }) : undefined
  const end = message.endLine === undefined || message.endColumn === undefined ? undefined : offsetAt(entry.tsx, { line: message.endLine, column: message.endColumn })
  const span = start === undefined ? undefined : sourceSpan(entry, start, end ?? start, 'fences')

  // A file that does not parse would otherwise pass: kay check names the reason at its line, this only keeps lint from passing.
  if (!span)
    return message.fatal ? { ...message, line: 1, column: 1, endLine: undefined, endColumn: undefined } : undefined

  const endPosition = end === undefined ? undefined : positionAt(entry.source, span.end)
  const fix = message.fix && mapFix(entry, message.fix)
  const suggestions = message.suggestions?.flatMap((suggestion) => {
    const mappedFix = mapFix(entry, suggestion.fix)

    return mappedFix ? [{ ...suggestion, fix: mappedFix }] : []
  })

  return { ...message, ...positionAt(entry.source, span.start), endLine: endPosition?.line, endColumn: endPosition?.column, fix, suggestions }
}

// A fix stands only when the fence code it replaces was copied verbatim from the .kay file.
function mapFix(entry: ShadowFile, fix: LintFix): LintFix | undefined {
  const span = fenceEdit(entry, fix.range[0], fix.range[1])

  return span && { range: [span.start, span.end], text: fix.text }
}
