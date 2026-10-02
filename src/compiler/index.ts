import type { Diagnostic } from './ast'
import type { SourceMap } from './mapping'
import { basename, relative } from 'node:path'
import process from 'node:process'
import { generate, isInteractive } from './codegen'
import { codeFrame } from './frame'
import { positionAt } from './mapping'
import { parseKay } from './parser'
import { findRewrites } from './rewrite'
import { analyzeScript, analyzeServer } from './script'

export type { Diagnostic } from './ast'
export { SourceMap } from './mapping'

export interface CompileOptions {
  // Island ids are paths relative to this directory, so server and client agree on them.
  root?: string
  // Browser builds pass false so `--- server` code never reaches the bundle.
  includeServer?: boolean
  // Parameters of the route this file serves, typing `ctx.params`.
  params?: string[]
  // Output for type checking: adds the link, form field and island prop assertions.
  check?: boolean
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
  const server = analyzeServer(source, file.server)
  // Every name the template uses comes from a fence, so the fences are all a clash can hide in.
  const fences = [file.script, file.server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
  const name = freeName(componentName(filename), fences)
  const island = isInteractive(file, script) ? islandId(filename, options.root) : undefined
  const generateOptions = { name, island, moduleId: islandId(filename, options.root), includeServer: options.includeServer, params: options.params, check: options.check }
  const analysis = generate(file, script, server, generateOptions)
  const bindings = [...(script.props?.bindings ?? []), ...(server?.data ?? []).map(data => ({ local: data.local, key: data.name }))]
  const { rewrites, diagnostics } = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings)
  const final = generate(file, script, server, { ...generateOptions, rewrites })

  return {
    tsx: final.builder.code,
    map: final.builder.map(),
    island,
    diagnostics: [...file.diagnostics, ...script.diagnostics, ...(server?.diagnostics ?? []), ...analysis.diagnostics, ...diagnostics].sort((a, b) => a.start - b.start),
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

// A page `table.kay` importing `components/table.kay` would otherwise declare a `Table` that shadows the import and renders itself.
function freeName(name: string, code: string): string {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code) ? freeName(`${name}Page`, code) : name
}

export function formatDiagnostic(source: string, filename: string, diagnostic: Diagnostic): string {
  const { line, column } = positionAt(source, diagnostic.start)

  return `${filename}:${line}:${column} - ${diagnostic.message}\n${codeFrame(source, diagnostic.start, diagnostic.end)}`
}
