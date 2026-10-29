import type { CheckDiagnostic } from '.'
import type { BundleInputs } from '../build/server-only'
import type { RouteMount } from '../server/routes'
import type { ImportEdge } from './island-modules'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { KAY_FILE, resolveFrom } from '../build/files'
import { browserRefuses, builtinChain, BUILTINS } from '../build/server-only'
import { positionAt } from '../compiler/mapping'
import { apiStubs, isApiStubbed } from '../server/api-modules'
import { importEdges, scriptImportsOf } from './island-modules'
import { importAt } from './server-only-reads'

const PACKAGE_DIR = /node_modules\/((?:@[^/]+\/)?[^/]+)/

const NAMED_IMPORTS = /\{([^}]*)\}/
const NAMESPACE_IMPORT = /\*\s*as\s+(\w+)/
const DEFAULT_IMPORT = /^\s*([\w$]+)\s*(?:,|$)/
const ESCAPED = /[.*+?^${}()|[\]\\]/g
const AS_NAME = /\s+as\s+/

const HELP = 'move what the island needs of it, a constant or a type, to a module importing no server code, or pass it as a prop'

// An import an island's chunk bundles: its own, or one of a child component it renders.
interface Probe {
  // The island's import the diagnostic stands at.
  specifier: string
  // The module holding the import and the import as written there, a builtin's name or not.
  file: string
  request: string
  builtin: boolean
  // The child components between the island and the module holding the import.
  via: string[]
}

function sourceOf(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  }
  catch {
    return undefined
  }
}

// The imports an island bundles: its own, and those of each `.kay` component it imports in turn, which the browser build compiles into the island's chunk.
function probesOf(seed: string, source: string, edges: ImportEdge[], stubbed: (file: string) => boolean, islands: Set<string>): Probe[] {
  const probes: Probe[] = edges.map(({ specifier, builtin }) => ({ specifier, file: seed, request: specifier, builtin: builtin === true, via: [] }))
  const seen = new Set(islands)

  const follow = (file: string, text: string, at: string | undefined, via: string[]): void => {
    for (const specifier of scriptImportsOf(text)) {
      const child = KAY_FILE.test(specifier) ? resolveFrom(specifier, file) : undefined
      const childSource = child === undefined || seen.has(child) ? undefined : sourceOf(child)

      if (child === undefined || childSource === undefined)
        continue

      seen.add(child)

      const path = [...via, child]

      for (const edge of importEdges(child, scriptImportsOf(childSource), stubbed))
        probes.push({ specifier: at ?? specifier, file: child, request: edge.specifier, builtin: edge.builtin === true, via: path })

      follow(child, childSource, at ?? specifier, path)
    }
  }

  follow(seed, source, undefined, [])

  return probes
}

// The module standing in for an import: it re-exports the names the file imports from `request`, as the build keeps only what an import uses of a package claiming no side effects, a type-only name left out.
function standIn(text: string, request: string): string {
  const pattern = new RegExp(String.raw`\bimport\s+(type\s+)?([^'"]*?)\s*from\s*(['"])${request.replace(ESCAPED, match => `\\${match}`)}\3`, 'g')
  const lines: string[] = []

  for (const [, typeOnly, clause] of text.matchAll(pattern)) {
    if (typeOnly !== undefined)
      continue

    const named = NAMED_IMPORTS.exec(clause!)?.[1]
    const namespace = NAMESPACE_IMPORT.exec(clause!)?.[1]
    const standard = DEFAULT_IMPORT.exec(clause!)?.[1]
    const members = (named ?? '').split(',').map(member => member.trim()).filter(member => member !== '' && !member.startsWith('type '))
    const taken = lines.length

    if (namespace !== undefined)
      lines.push(`export * as ns${taken} from ${JSON.stringify(request)}`)

    if (standard !== undefined && namespace === undefined)
      lines.push(`export { default as d${taken} } from ${JSON.stringify(request)}`)

    if (members.length > 0)
      lines.push(`export { ${members.map((member, at) => `${member.split(AS_NAME)[0]} as m${taken}_${at}`).join(', ')} } from ${JSON.stringify(request)}`)
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : `import ${JSON.stringify(request)}\n`
}

// The metafile inputs of the entries bundled for the browser as the build does, or nothing when they fail to.
async function bundle(files: Record<string, string>, root: string, api: RouteMount[]): Promise<BundleInputs | undefined> {
  const result = await Bun.build({
    entrypoints: Object.keys(files),
    files,
    root,
    target: 'browser',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    external: [...BUILTINS, 'kay', 'kay/*', '*.kay', '~icons/*'],
    plugins: api.length > 0 ? [apiStubs(api)] : [],
    throw: false,
  })

  return result.success ? result.metafile!.inputs : undefined
}

// The build's refusal of an island whose imports reach a builtin a browser lacks, found before it by the same bundling: the modules each island imports, bundled for the browser with the builtins left out, give the chain to the builtin as the build prints it.
// Reported at each of the island's own imports leading there, the ones of a component it renders included. An import that fails to bundle is left to the build, which says why, and leaves the others reported.
export async function builtinImportsInIsland(root: string, seeds: string[], edges: Map<string, ImportEdge[]>, api: RouteMount[]): Promise<CheckDiagnostic[]> {
  const refuses = await browserRefuses()
  const stubbed = isApiStubbed(api)
  const islands = new Set(seeds)
  const sources = new Map<string, string>()
  const probes = new Map<string, Probe[]>()
  // Each import is bundled from a module beside the one holding it that only re-exports what the file takes of it, so the bundler resolves it as the build does, a package's browser condition included, and keeps what it takes of a package claiming no side effects, as the build does.
  const files: Record<string, string> = {}
  const entryOf = new Map<Probe, string>()
  const shared = new Map<string, string>()

  for (const seed of seeds) {
    const source = await Bun.file(seed).text()
    const found = probesOf(seed, source, edges.get(seed) ?? [], stubbed, islands)

    sources.set(seed, source)
    probes.set(seed, found)

    for (const probe of found) {
      if (probe.builtin)
        continue

      const content = standIn(sourceOf(probe.file) ?? '', probe.request)
      const key = `${dirname(probe.file)}\0${content}`
      let entry = shared.get(key)

      if (entry === undefined) {
        entry = join(dirname(probe.file), `.kay-import-${shared.size}.js`)
        shared.set(key, entry)
        files[entry] = content
      }

      entryOf.set(probe, entry)
    }
  }

  let inputs: BundleInputs = {}

  if (entryOf.size > 0) {
    const all = await bundle(files, root, api)

    if (all) {
      inputs = all
    }
    else {
      // One import failing fails the bundle, so each is tried alone and the ones that fail drop out.
      for (const [entry, content] of Object.entries(files))
        Object.assign(inputs, await bundle({ [entry]: content }, root, api))
    }
  }

  const keyOf = new Map(Object.keys(inputs).map(input => [resolve(process.cwd(), input), input]))
  const project = realpathSync(root)
  const diagnostics: CheckDiagnostic[] = []

  for (const seed of seeds) {
    const source = sources.get(seed)!
    const island = relative(project, realpathSync(seed))
    const reported = new Set<string>()

    for (const probe of probes.get(seed)!) {
      let chain: string | undefined
      let reached = probe.request

      if (probe.builtin) {
        chain = refuses(probe.request) ? probe.request : undefined
      }
      else {
        const start = keyOf.get(entryOf.get(probe)!)
        const found = start === undefined ? undefined : builtinChain(root, inputs, start, { has: refuses })

        // The chain opens on the module standing in for the module holding the import.
        chain = found?.text.slice(found.text.indexOf(' -> ') + 4)
        reached = found?.path.at(-1) ?? probe.request
      }

      if (chain === undefined)
        continue

      // A component of a package is shown as the package, the way a chain is cut at its first one.
      const library = PACKAGE_DIR.exec(probe.via[0] ?? '')?.[1]
      const route = (library === undefined ? [island, ...probe.via.map(child => relative(project, realpathSync(child))), chain] : [island, library, reached]).join(' -> ')

      // One report per island and chain, however many of its imports lead there.
      if (reported.has(route))
        continue

      reported.add(route)
      diagnostics.push({ file: seed, ...positionAt(source, importAt(source, probe.specifier, KAY_FILE.test(seed))), message: `${island} imports a server module, and a browser has no ${reached}: ${route}`, code: 'browser-builtin-import', severity: 'error', help: HELP })
    }
  }

  return diagnostics
}
