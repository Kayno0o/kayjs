import type { Diagnostic, Node } from './ast'
import type { SourceMap } from './mapping'
import { basename, relative } from 'node:path'
import process from 'node:process'
import { awaitBlocks } from './ast'
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
  relocateImport?: (specifier: string) => string | undefined
  // Server output for rendering outside islands, without hydration markers: a static component renders through its hydratable `?island` twin inside one.
  staticRender?: boolean
}

export interface CompileResult {
  tsx: string
  map: SourceMap
  // Set when the component is interactive and renders as an island.
  island?: string
  // The `.class` shorthand names, which CSS tools scanning for class names cannot read off `div.md:flex.w-1/2`.
  classes: string[]
  diagnostics: Diagnostic[]
}

const WORD = /[a-z0-9]+/gi
const LEADING_DIGIT = /^\d/
const KAY_EXTENSION = /\.kay$/
const ERROR_PAGE = '_error.kay'
const BACKSLASH = /\\/g

export const ISLAND_TWIN = '?island'

// The `.kay` file a module path names, its `?island` twin included.
export function withoutTwin(path: string): string {
  return path.endsWith(ISLAND_TWIN) ? path.slice(0, -ISLAND_TWIN.length) : path
}

// Compiles a .kay component to TSX that is both type-checked and handed to Solid's compiler.
export function compileKay(source: string, filename: string, options: CompileOptions = {}): CompileResult {
  const file = parseKay(source)
  const server = analyzeServer(source, file.server)
  const script = analyzeScript(source, file.script, server?.data.map(data => data.name))
  // A name a fence uses may clash with the component's own; the template's reads are found once the code is generated.
  const fences = [file.script, file.server].map(span => span ? source.slice(span.start, span.end) : '').join('\n')
  let name = freeName(componentName(filename), fences)
  const island = isInteractive(file, script) ? islandId(filename, options.root) : undefined
  const twin = options.staticRender && !island && !file.server ? `./${basename(filename)}${ISLAND_TWIN}` : undefined
  const generateOptions = { island, twin, moduleId: islandId(filename, options.root), includeServer: options.includeServer, params: options.params, check: options.check, relocateImport: options.relocateImport, errorPage: basename(filename) === ERROR_PAGE, special: basename(filename).startsWith('_') }
  const bindings = [...(script.props?.bindings ?? []), ...(server?.data ?? []).map(data => ({ local: data.local, key: data.name }))]
  let analysis = generate(file, script, server, { ...generateOptions, name })
  let found = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings, name)

  // A `date.kay` declaring `function Date` would break the `new Date()` its template reads.
  while (found.shadowsName) {
    name = `${name}Page`
    analysis = generate(file, script, server, { ...generateOptions, name })
    found = findRewrites(analysis.builder.code, analysis.builder.map(), analysis.accessorSites, bindings, name)
  }

  const final = generate(file, script, server, { ...generateOptions, name, rewrites: found.rewrites })
  const diagnostics = [...file.diagnostics, ...script.diagnostics, ...(server?.diagnostics ?? []), ...analysis.diagnostics, ...found.diagnostics]

  // Code that does not parse usually already has a better diagnostic from the fence or the template; this one is what is left when nothing else explains it.
  if (found.syntaxError && diagnostics.length === 0)
    diagnostics.push(found.syntaxError)

  return {
    tsx: final.builder.code,
    map: final.builder.map(),
    island,
    classes: shorthandClasses(file.template, source),
    diagnostics: diagnostics.sort((a, b) => a.start - b.start),
  }
}

function shorthandClasses(nodes: Node[], source: string, found: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind === 'element') {
      for (const span of node.classes)
        found.push(source.slice(span.start, span.end))
      shorthandClasses(node.children, source, found)
    }
    else if (node.kind === 'text') {
      shorthandClasses(node.parts.filter(part => part.kind === 'element'), source, found)
    }
    else if (node.kind === 'if') {
      for (const branch of node.branches)
        shorthandClasses(branch.children, source, found)
    }
    else if (node.kind === 'await') {
      shorthandClasses(awaitBlocks(node).flat(), source, found)
    }
    else {
      shorthandClasses([...node.children, ...(node.kind === 'for' ? node.fallback ?? [] : [])], source, found)
    }
  }

  return found
}

export function islandId(filename: string, root = process.cwd()): string {
  return relative(root, filename).replace(BACKSLASH, '/')
}

// `todo-item.kay` becomes `TodoItem`, the name stack traces and devtools show.
export function componentName(filename: string): string {
  const words = basename(filename).replace(KAY_EXTENSION, '').match(WORD) ?? []
  const name = words.map(word => word[0]!.toUpperCase() + word.slice(1)).join('')

  return name === '' || LEADING_DIGIT.test(name) ? `Page${name}` : name
}

// A page `table.kay` importing `components/table.kay` would otherwise declare a `Table` that shadows the import and renders itself.
function freeName(name: string, code: string): string {
  return new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(code) ? freeName(`${name}Page`, code) : name
}

export function formatDiagnostic(source: string, filename: string, diagnostic: Diagnostic): string {
  const { line, column } = positionAt(source, diagnostic.start)

  return `${filename}:${line}:${column} - ${diagnostic.message}\n${codeFrame(source, diagnostic.start, diagnostic.end)}`
}
