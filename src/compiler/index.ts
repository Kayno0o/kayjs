import type { Diagnostic } from './ast'
import type { SourceMap } from './mapping'
import { basename } from 'node:path'
import { generate } from './codegen'
import { positionAt } from './mapping'
import { parseKay } from './parser'
import { findRewrites } from './rewrite'
import { analyzeScript } from './script'

export type { Diagnostic } from './ast'
export { SourceMap } from './mapping'

export interface CompileResult {
  tsx: string
  map: SourceMap
  diagnostics: Diagnostic[]
}

const WORD = /[a-z0-9]+/gi
const LEADING_DIGIT = /^\d/

// Compiles a .kay component to TSX that is both type-checked and handed to Solid's compiler.
export function compileKay(source: string, filename: string): CompileResult {
  const file = parseKay(source)
  const script = analyzeScript(source, file.script)
  const name = componentName(filename)
  const analysis = generate(file, script, { name })
  const { rewrites, diagnostics } = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, script)
  const final = generate(file, script, { name, rewrites })

  return {
    tsx: final.builder.code,
    map: final.builder.map(),
    diagnostics: [...file.diagnostics, ...script.diagnostics, ...analysis.diagnostics, ...diagnostics].sort((a, b) => a.start - b.start),
  }
}

// `todo-item.kay` becomes `TodoItem`, the name stack traces and devtools show.
export function componentName(filename: string): string {
  const words = basename(filename).replace(/\.kay$/, '').match(WORD) ?? []
  const name = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  return name === '' || LEADING_DIGIT.test(name) ? `Kay${name}` : name
}

export function formatDiagnostic(source: string, filename: string, diagnostic: Diagnostic): string {
  const { line, column } = positionAt(source, diagnostic.start)

  return `${filename}:${line}:${column} - ${diagnostic.message}`
}
