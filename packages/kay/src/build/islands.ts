// Island discovery & reachability: which exports run in the browser, which modules render them, and the checks that keep server code out of them.

import type { ModuleAnalysis } from '../compiler/analyze'
import type { ServerOnlyInIsland } from '../compiler/interactivity'
import type { ModuleGraph } from './graph'
import { basename, extname } from 'node:path'
import { asyncInteractiveError } from '../compiler/analyze'
import { withStateReads } from '../compiler/interactivity'
import { serverOnlyTagError } from '../compiler/mistakes'
import { findPrivateEnvOffset, SERVER_ONLY_MODULES } from '../compiler/server-only'
import { isTsFile, relPosix } from './files'

export interface IslandTarget {
  id: string
  file: string
  exportName: string
  defaultHydrate: string | undefined
}

export type ActionsByFile = Map<string, { exportName: string, url: string }[]>

export type IslandIssue
  = | { kind: 'async-interactive', file: string, offset: number, reason: string | undefined }
    | { kind: 'server-only-tag', file: string, serverOnly: ServerOnlyInIsland }
    | { kind: 'special-interactive', file: string, offset: number, reason: string | undefined }
    | { kind: 'action-export', file: string, target: string, name: string, offset: number, reexport: boolean }
    | { kind: 'server-only-import', file: string, island: string, source: string, offset: number, reexport: boolean }
    | { kind: 'private-env', file: string, island: string, offset: number }

export interface IslandPlan {
  /** Island roots keyed `file#exportName`. */
  targets: Map<string, IslandTarget>
  /** Per static module, the island each rendered tag stands for. */
  pageBindings: Map<string, Map<string, IslandTarget>>
  /** CSS files imported (transitively) by an island: bundled with it, not as standalone styles. */
  cssFiles: Set<string>
  /** Modules the client compiles for an island, whose SSR must emit hydration markers too. */
  reach: Set<string>
  /** Island and reachability issues found during analysis. */
  issues: IslandIssue[]
}

export interface AnalyzeIslandsOptions {
  graph: ModuleGraph
  root: string
  pageFiles: readonly string[]
  specialFiles: readonly string[]
  /** Custom module loader (e.g. `kay check` collects parse errors and returns `undefined` on unparsable files). */
  load?: ((file: string) => ModuleAnalysis | undefined) | undefined
  /** Also walk reachability from every interactive module in `graph.analyses`, even if no route renders it yet. */
  includeAllInteractive?: boolean | undefined
  /** Check server-only module imports and private `process.env`/`Bun.env` reads during the static reachability walk. */
  checkLeaks?: boolean | undefined
}

type LoadModule = (file: string) => ModuleAnalysis | undefined

const MAX_REEXPORT_DEPTH = 8
const NODE_MODULES_RE = /[\\/]node_modules[\\/]/

export function islandKey(target: { file: string, exportName: string }): string {
  return `${target.file}#${target.exportName}`
}

/** A non-interactive module with exported actions is replaced by action stubs in the browser bundle. */
export function isStubbedActionFile(analysis: ModuleAnalysis | undefined): boolean {
  return analysis !== undefined && !analysis.isInteractive && analysis.exportedActions.length > 0
}

export function clientLeakError(leaks: Set<string>): Error {
  return new Error(`kay build (client): server code is reachable from an island:\n${[...leaks].map(l => `  ${l}`).join('\n')}\nMove server logic to a server action or async server component.`)
}

/** Follows `export { x } from './y'` and `export * from './y'` chains using `load` so parse errors are never swallowed. */
function resolveExportTarget(
  graph: ModuleGraph,
  load: LoadModule,
  file: string,
  exportName: string,
  depth = 0,
  seen = new Set<string>(),
): { file: string, exportName: string } | undefined {
  if (depth > MAX_REEXPORT_DEPTH)
    return { file, exportName }
  const key = `${file}\0${exportName}`
  if (seen.has(key))
    return { file, exportName }
  seen.add(key)

  const analysis = load(file)
  if (analysis === undefined)
    return undefined
  const direct = analysis.reexports.find(r => r.exported === exportName)
  if (direct !== undefined) {
    const next = graph.resolve(file, direct.source)
    if (next !== undefined && isTsFile(next))
      return resolveExportTarget(graph, load, next, direct.local, depth + 1, seen)
  }

  if (analysis.exportedNames.includes(exportName))
    return { file, exportName }

  // Follow `export * from './y'` barrel re-exports (named exports only, per ESM spec `export *` never re-exports `default`).
  if (exportName !== 'default') {
    for (const re of analysis.reexports) {
      if (re.exported !== '*')
        continue
      const next = graph.resolve(file, re.source)
      if (next === undefined || !isTsFile(next))
        continue
      const candidate = resolveExportTarget(graph, load, next, exportName, depth + 1, seen)
      if (candidate !== undefined && load(candidate.file)?.exportedNames.includes(candidate.exportName))
        return candidate
    }
  }

  return { file, exportName }
}

function createPromoter(graph: ModuleGraph, load: LoadModule, issues: IslandIssue[]): LoadModule {
  const promotedFiles = new Set<string>()
  return (file: string): ModuleAnalysis | undefined => {
    const analysis = load(file)
    if (analysis === undefined || !file.endsWith('.tsx') || promotedFiles.has(file))
      return analysis
    promotedFiles.add(file)
    const promoted = withStateReads(analysis, (imp, imported) => {
      const resolved = graph.resolve(file, imp.source)
      if (resolved === undefined || !isTsFile(resolved))
        return false
      if (imported === '*')
        return (load(resolved)?.stateExports.length ?? 0) > 0
      const target = resolveExportTarget(graph, load, resolved, imported)
      return target !== undefined && load(target.file)?.stateExports.includes(target.exportName) === true
    })
    if (promoted === undefined)
      return analysis
    const page = promoted.exports.get('default')
    if (analysis.hasAsyncDefault && page?.interactive === true) {
      issues.push({ kind: 'async-interactive', file, offset: page.offset ?? 0, reason: page.reason })
      return analysis
    }
    if (promoted.serverOnly !== undefined) {
      issues.push({ kind: 'server-only-tag', file, serverOnly: promoted.serverOnly })
      return analysis
    }
    const next = { ...analysis, ...promoted }
    graph.analyses.set(file, next)
    return next
  }
}

function discoverBindings(
  graph: ModuleGraph,
  load: LoadModule,
  loadPromoted: LoadModule,
  pageSet: ReadonlySet<string>,
  registerIsland: (file: string, exportName: string) => IslandTarget,
): Map<string, Map<string, IslandTarget>> {
  const pageBindings = new Map<string, Map<string, IslandTarget>>()
  for (const file of [...graph.analyses.keys()]) {
    if (!file.endsWith('.tsx'))
      continue
    const analysis = graph.analyses.get(file)!
    if (analysis.exports.get('default')?.interactive === true && pageSet.has(file)) {
      registerIsland(file, 'default')
      if (analysis.staticJsxTags.size === 0)
        continue
    }
    if (analysis.staticJsxTags.size === 0)
      continue

    // Only names rendered as tags from server-side code become islands: `<Counter />`, or `<UI.Counter />` through a namespace import.
    const bindings = new Map<string, IslandTarget>()
    for (const imp of analysis.imports) {
      const resolved = graph.resolve(file, imp.source)
      if (resolved === undefined || !isTsFile(resolved))
        continue
      for (const spec of imp.specifiers) {
        const tags = spec.imported === '*'
          ? [...analysis.staticJsxTags].filter(tag => tag.startsWith(`${spec.local}.`) && !tag.slice(spec.local.length + 1).includes('.')).map(tag => [tag, tag.slice(spec.local.length + 1)] as const)
          : analysis.staticJsxTags.has(spec.local) ? [[spec.local, spec.imported] as const] : []
        for (const [tag, exportName] of tags) {
          const target = resolveExportTarget(graph, load, resolved, exportName)
          if (target !== undefined && target.file.endsWith('.tsx') && loadPromoted(target.file)?.exports.get(target.exportName)?.interactive === true)
            bindings.set(tag, registerIsland(target.file, target.exportName))
        }
      }
    }
    if (bindings.size > 0)
      pageBindings.set(file, bindings)
  }
  return pageBindings
}

function checkReachEdges(
  graph: ModuleGraph,
  load: LoadModule,
  file: string,
  island: string,
  analysis: ModuleAnalysis,
  checkFileLeaks: boolean,
  cssFiles: Set<string>,
  issues: IslandIssue[],
  enqueue: (target: string, island: string) => void,
): void {
  const reported = new Set<string>()
  const loadTarget = (target: string): ModuleAnalysis | undefined =>
    NODE_MODULES_RE.test(target) ? graph.analyses.get(target) : load(target)

  for (const imp of analysis.imports) {
    if (SERVER_ONLY_MODULES.has(imp.source)) {
      if (checkFileLeaks && !reported.has(imp.source)) {
        reported.add(imp.source)
        issues.push({ kind: 'server-only-import', file, island, source: imp.source, offset: imp.start, reexport: false })
      }
      continue
    }
    const target = graph.resolve(file, imp.source)
    if (target === undefined)
      continue
    if (target.endsWith('.css')) {
      cssFiles.add(target)
      continue
    }
    if (!isTsFile(target))
      continue
    const targetAnalysis = loadTarget(target)
    if (isStubbedActionFile(targetAnalysis)) {
      const missing = imp.specifiers.find(s => s.imported !== '*' && !targetAnalysis!.exportedActions.includes(s.imported))
      if (missing !== undefined && !reported.has(`action:${target}:${missing.imported}`)) {
        reported.add(`action:${target}:${missing.imported}`)
        issues.push({ kind: 'action-export', file, target, name: missing.imported, offset: imp.start, reexport: false })
      }
      continue
    }
    enqueue(target, island)
  }

  for (const re of analysis.reexports) {
    if (SERVER_ONLY_MODULES.has(re.source)) {
      if (checkFileLeaks && !reported.has(re.source)) {
        reported.add(re.source)
        issues.push({ kind: 'server-only-import', file, island, source: re.source, offset: re.start, reexport: true })
      }
      continue
    }
    const target = graph.resolve(file, re.source)
    if (target === undefined || !isTsFile(target))
      continue
    const targetAnalysis = loadTarget(target)
    if (isStubbedActionFile(targetAnalysis)) {
      if (re.local !== '*' && !targetAnalysis!.exportedActions.includes(re.local) && !reported.has(`action:${target}:${re.local}`)) {
        reported.add(`action:${target}:${re.local}`)
        issues.push({ kind: 'action-export', file, target, name: re.local, offset: re.start, reexport: true })
      }
      continue
    }
    enqueue(target, island)
  }
}

function walkIslandReach(
  graph: ModuleGraph,
  load: LoadModule,
  roots: readonly string[],
  checkLeaks: boolean,
  issues: IslandIssue[],
): { reach: Set<string>, cssFiles: Set<string> } {
  const reach = new Set<string>()
  const cssFiles = new Set<string>()
  const visited = new Set<string>()
  const queue: { file: string, island: string }[] = []

  const enqueue = (file: string, island: string): void => {
    if (visited.has(file))
      return
    visited.add(file)
    queue.push({ file, island })
  }

  for (const root of roots)
    enqueue(root, root)

  for (let i = 0; i < queue.length; i++) {
    const { file, island } = queue[i]!
    if (file.endsWith('.tsx'))
      reach.add(file)
    const inNodeModules = NODE_MODULES_RE.test(file)
    const analysis = inNodeModules ? graph.analyses.get(file) : load(file)
    if (analysis === undefined)
      continue
    if (file !== island && isStubbedActionFile(analysis))
      continue

    const checkFileLeaks = checkLeaks && !inNodeModules
    checkReachEdges(graph, load, file, island, analysis, checkFileLeaks, cssFiles, issues, enqueue)
    if (checkFileLeaks) {
      const envOffset = findPrivateEnvOffset(analysis.program)
      if (envOffset !== undefined)
        issues.push({ kind: 'private-env', file, island, offset: envOffset })
    }
  }

  return { reach, cssFiles }
}

/** Shared island planning and reachability analyzer used by both `kay build` and `kay check`. */
export function analyzeIslands(options: AnalyzeIslandsOptions): IslandPlan {
  const { graph, root, pageFiles, specialFiles } = options
  const load: LoadModule = options.load ?? (file => graph.load(file))
  const issues: IslandIssue[] = []
  const targets = new Map<string, IslandTarget>()
  const usedIds = new Set<string>()
  const pageSet = new Set(pageFiles)

  function registerIsland(file: string, exportName: string): IslandTarget {
    const key = islandKey({ file, exportName })
    const existing = targets.get(key)
    if (existing !== undefined)
      return existing
    const baseName = basename(file, extname(file)).toLowerCase()
    const expLower = exportName.toLowerCase()
    let id = exportName === 'default' || expLower === baseName ? baseName : `${baseName}-${expLower}`
    // The id names the entry file and the chunk: two islands sharing a basename keep it readable and add a hash of their path.
    if (usedIds.has(id))
      id = `${id}-${Bun.hash(relPosix(root, key)).toString(36).slice(0, 6)}`
    usedIds.add(id)
    const target: IslandTarget = { id, file, exportName, defaultHydrate: load(file)?.defaultHydrate }
    targets.set(key, target)
    return target
  }

  // A component reading reactive state another module exports runs in the browser too. The promoted analysis lives in this run's map only, so the cached one still reflects the file alone.
  const loadPromoted = createPromoter(graph, load, issues)
  for (const file of [...graph.analyses.keys()]) {
    if (file.endsWith('.tsx'))
      loadPromoted(file)
  }

  const pageBindings = discoverBindings(graph, load, loadPromoted, pageSet, registerIsland)

  // A layout, error or 404 page renders on the server only, so interactivity written in it would never run.
  for (const file of specialFiles) {
    const page = graph.analyses.get(file)?.exports.get('default')
    if (page?.interactive === true)
      issues.push({ kind: 'special-interactive', file, offset: page.offset ?? 0, reason: page.reason })
  }

  const rootFiles = new Set<string>([...targets.values()].map(t => t.file))
  if (options.includeAllInteractive) {
    for (const [file, analysis] of graph.analyses) {
      if (analysis.isInteractive)
        rootFiles.add(file)
    }
  }

  const { reach, cssFiles } = walkIslandReach(graph, load, [...rootFiles], options.checkLeaks === true, issues)
  return { targets, pageBindings, cssFiles, reach, issues }
}

export function planIslands(graph: ModuleGraph, root: string, pageFiles: string[], specialFiles: string[]): IslandPlan {
  const plan = analyzeIslands({ graph, root, pageFiles, specialFiles, checkLeaks: true })
  const leaks = new Set<string>()
  for (const issue of plan.issues) {
    const rel = relPosix(root, issue.file)
    if (issue.kind === 'async-interactive')
      throw asyncInteractiveError(issue.file, issue.reason)
    if (issue.kind === 'server-only-tag')
      throw serverOnlyTagError(rel, issue.serverOnly)
    if (issue.kind === 'special-interactive')
      throw new Error(`kay build: ${rel} uses browser interactivity (${issue.reason}), but it renders on the server only. Move the interactive part into a component and render that component from ${rel}.`)
    if (issue.kind === 'action-export') {
      const verb = issue.reexport ? 're-exports' : 'imports'
      throw new Error(`kay build: ${rel} runs in the browser and ${verb} ${issue.name} from ${relPosix(root, issue.target)}, a file of server actions: the browser only gets its actions. Move ${issue.name} into a module without actions.`)
    }
    if (issue.kind === 'server-only-import')
      leaks.add(issue.reexport ? `${rel} re-exports from server-only module "${issue.source}"` : `${rel} imports server-only module "${issue.source}"`)
    if (issue.kind === 'private-env')
      leaks.add(`${rel} reads process.env or Bun.env (only a process.env.PUBLIC_* set at build time is inlined)`)
  }
  if (leaks.size > 0)
    throw clientLeakError(leaks)
  return plan
}
