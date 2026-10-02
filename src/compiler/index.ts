import type { Diagnostic } from './ast'
import type { SourceMap } from './mapping'
import { basename, relative } from 'node:path'
import process from 'node:process'
import { generate, isInteractive } from './codegen'
import { positionAt } from './mapping'
import { parseKay } from './parser'
import { findRewrites } from './rewrite'
import { analyzeScript } from './script'

export type { Diagnostic } from './ast'
export { SourceMap } from './mapping'

export interface CompileOptions {
  // Island ids are paths relative to this directory, so server and client agree on them.
  root?: string
}

export interface CompileResult {
  tsx: string
  map: SourceMap
  // Set when the component is interactive and renders as an island.
  island?: string
  diagnostics: Diagnostic[]
}

const WORD = /[a-z0-9]+/gi
const LEADING_DIGIT = /^\d/
const KAY_EXTENSION = /\.kay$/
const BACKSLASH = /\\/g

// Compiles a .kay component to TSX that is both type-checked and handed to Solid's compiler.
export function compileKay(source: string, filename: string, options: CompileOptions = {}): CompileResult {
  const file = parseKay(source)
  const script = analyzeScript(source, file.script)
  const name = componentName(filename)
  const island = isInteractive(file, script) ? islandId(filename, options.root) : undefined
  const analysis = generate(file, script, { name, island })
  const { rewrites, diagnostics } = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, script)
  const final = generate(file, script, { name, island, rewrites })

  return {
    tsx: final.builder.code,
    map: final.builder.map(),
    island,
    diagnostics: [...file.diagnostics, ...script.diagnostics, ...analysis.diagnostics, ...diagnostics].sort((a, b) => a.start - b.start),
  }
}

export function islandId(filename: string, root = process.cwd()): string {
  return relative(root, filename).replace(BACKSLASH, '/')
}

// `todo-item.kay` becomes `TodoItem`, the name stack traces and devtools show.
export function componentName(filename: string): string {
  const words = basename(filename).replace(KAY_EXTENSION, '').match(WORD) ?? []
  const name = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  return name === '' || LEADING_DIGIT.test(name) ? `Kay${name}` : name
}

export function formatDiagnostic(source: string, filename: string, diagnostic: Diagnostic): string {
  const { line, column } = positionAt(source, diagnostic.start)

  return `${filename}:${line}:${column} - ${diagnostic.message}`
}
