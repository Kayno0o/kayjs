// Island discovery & reachability: which exports run in the browser, which modules render them, and the checks that keep server code out of them.

import type { ModuleAnalysis } from '../compiler/analyze'
import type { ServerOnlyInIsland } from '../compiler/interactivity'
import type { ModuleGraph } from './graph'
import { basename, extname } from 'node:path'
import { asyncInteractiveError } from '../compiler/analyze'
import { findCrossFileServerOnly, withStateReads } from '../compiler/interactivity'
import { collectMistakes, serverOnlyTagError } from '../compiler/mistakes'
import { findPrivateEnv, isServerOnlyModule } from '../compiler/server-only'
import { checkBareSignals } from '../compiler/signal-reads'
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
    | { kind: 'interactive-action', file: string, name: string, offset: number, reason: string | undefined }
    | { kind: 'action-export', file: string, target: string, name: string, offset: number, reexport: boolean }
    | { kind: 'server-only-import', file: string, island: string, source: string, offset: number, reexport: boolean }
    | { kind: 'private-env', file: string, island: string, offset: number, envKind: 'process' | 'bun' }
    | { kind: 'compiler-mistake', file: string, offset: number, message: string }

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

const EMPTY_SET = new Set<string>()

function moduleHasInteractiveExport(graph: ModuleGraph, load: LoadModule, file: string, seen = new Set<string>()): boolean {
  if (seen.has(file))
    return false
  seen.add(file)
  const analysis = graph.analyses.get(file) ?? load(file)
  if (analysis === undefined)
    return false
  if (analysis.stateExports.length > 0 || [...analysis.exports.values()].some(e => e.interactive))
    return true
  for (const re of analysis.reexports) {
    const next = graph.resolve(file, re.source)
    if (next === undefined || !isTsFile(next))
      continue
    if (re.exported === '*') {
      if (moduleHasInteractiveExport(graph, load, next, seen))
        return true
    }
    else {
      const target = resolveExportTarget(graph, load, next, re.local)
      const targetAnalysis = target === undefined ? undefined : (graph.analyses.get(target.file) ?? load(target.file))
      if (target !== undefined && (targetAnalysis?.stateExports.includes(target.exportName) === true || targetAnalysis?.exports.get(target.exportName)?.interactive === true))
        return true
    }
  }
  return false
}

function collectExportedSignals(graph: ModuleGraph, load: LoadModule, file: string, out: Set<string>, seen = new Set<string>()): void {
  if (seen.has(file))
    return
  seen.add(file)
  const analysis = graph.analyses.get(file) ?? load(file)
  if (analysis === undefined)
    return
  for (const name of analysis.signalExports)
    out.add(name)
  for (const re of analysis.reexports) {
    const next = graph.resolve(file, re.source)
    if (next === undefined || !isTsFile(next))
      continue
    if (re.exported === '*') {
      collectExportedSignals(graph, load, next, out, seen)
    }
    else {
      const target = resolveExportTarget(graph, load, next, re.local)
      if (target !== undefined && (graph.analyses.get(target.file) ?? load(target.file))?.signalExports.includes(target.exportName) === true)
        out.add(re.exported)
    }
  }
}

function interactivityChanged(prev: ModuleAnalysis, next: { isInteractive: boolean, exports: Map<string, { interactive: boolean }> }): boolean {
  if (prev.isInteractive !== next.isInteractive)
    return true
  for (const [name, fact] of next.exports) {
    if (prev.exports.get(name)?.interactive !== fact.interactive)
      return true
  }
  return false
}

function createPromoter(graph: ModuleGraph, load: LoadModule, issues: IslandIssue[]): { promoteAll: () => void, loadPromoted: LoadModule } {
  const initialAsyncInteractive = new Set<string>()
  const initialServerOnly = new Set<string>()
  const reportedAsync = new Set<string>()
  const reportedServerOnly = new Set<string>()

  const recordInitial = (file: string, a: ModuleAnalysis): void => {
    if (a.hasAsyncDefault && a.exports.get('default')?.interactive === true)
      initialAsyncInteractive.add(file)
    if (a.serverOnly !== undefined)
      initialServerOnly.add(file)
  }
  for (const [file, a] of graph.analyses)
    recordInitial(file, a)

  const isInteractiveTarget = (file: string, source: string, imported: string): boolean => {
    const resolved = graph.resolve(file, source)
    if (resolved === undefined || !isTsFile(resolved))
      return false
    if (imported === '*')
      return moduleHasInteractiveExport(graph, load, resolved)
    const target = resolveExportTarget(graph, load, resolved, imported)
    if (target === undefined)
      return false
    const targetAnalysis = graph.analyses.get(target.file) ?? load(target.file)
    return targetAnalysis?.stateExports.includes(target.exportName) === true
      || targetAnalysis?.exports.get(target.exportName)?.interactive === true
  }

  const promoteOne = (file: string): boolean => {
    if (NODE_MODULES_RE.test(file) || !isTsFile(file))
      return false
    const analysis = graph.analyses.get(file)
    if (analysis === undefined)
      return false
    const promoted = withStateReads(analysis, (imp, imported) => isInteractiveTarget(file, imp.source, imported))
    if (promoted === undefined)
      return false
    const page = promoted.exports.get('default')
    if (analysis.hasAsyncDefault && page?.interactive === true) {
      if (!initialAsyncInteractive.has(file) && !reportedAsync.has(file)) {
        reportedAsync.add(file)
        issues.push({ kind: 'async-interactive', file, offset: page.offset ?? 0, reason: page.reason })
      }
      return false
    }
    if (promoted.serverOnly !== undefined) {
      if (!initialServerOnly.has(file) && !reportedServerOnly.has(file)) {
        reportedServerOnly.add(file)
        issues.push({ kind: 'server-only-tag', file, serverOnly: promoted.serverOnly })
      }
      return false
    }
    if (!interactivityChanged(analysis, promoted))
      return false
    graph.analyses.set(file, { ...analysis, ...promoted })
    return true
  }

  const promoteAll = (): void => {
    for (let pass = 0; pass < MAX_REEXPORT_DEPTH; pass++) {
      let changed = false
      for (const file of [...graph.analyses.keys()]) {
        if (promoteOne(file))
          changed = true
      }
      if (!changed)
        break
    }
  }

  const loadPromoted: LoadModule = (file: string): ModuleAnalysis | undefined => {
    const existed = graph.analyses.has(file)
    const analysis = graph.analyses.get(file) ?? load(file)
    if (analysis === undefined)
      return undefined
    if (!existed) {
      recordInitial(file, analysis)
      promoteAll()
    }
    return graph.analyses.get(file) ?? analysis
  }

  return { promoteAll, loadPromoted }
}

function checkImportedBareSignals(graph: ModuleGraph, load: LoadModule, root: string, issues: IslandIssue[]): void {
  for (const [file, analysis] of [...graph.analyses]) {
    if (NODE_MODULES_RE.test(file) || !isTsFile(file))
      continue
    const importedSignals = new Set<string>()
    const importedSignalMembers = new Map<string, Set<string>>()
    for (const imp of analysis.imports) {
      const resolved = graph.resolve(file, imp.source)
      if (resolved === undefined || !isTsFile(resolved))
        continue
      for (const spec of imp.specifiers) {
        if (spec.imported === '*') {
          const members = new Set<string>()
          collectExportedSignals(graph, load, resolved, members)
          if (members.size > 0)
            importedSignalMembers.set(spec.local, members)
        }
        else {
          const target = resolveExportTarget(graph, load, resolved, spec.imported)
          if (target !== undefined && (graph.analyses.get(target.file) ?? load(target.file))?.signalExports.includes(target.exportName) === true)
            importedSignals.add(spec.local)
        }
      }
    }
    if (importedSignals.size === 0 && importedSignalMembers.size === 0)
      continue
    const { mistakes } = collectMistakes(() => checkBareSignals(analysis.program, EMPTY_SET, relPosix(root, file), importedSignals, importedSignalMembers))
    for (const m of mistakes)
      issues.push({ kind: 'compiler-mistake', file, offset: m.start ?? 0, message: m.message })
  }
}

function checkCrossFileServerOnlyTags(graph: ModuleGraph, load: LoadModule, issues: IslandIssue[]): void {
  const loadMod = (f: string): ModuleAnalysis | undefined => graph.analyses.get(f) ?? load(f)
  const resolveTarget = (fromFile: string, source: string, exportName: string): { file: string, exportName: string } | undefined => {
    const resolved = graph.resolve(fromFile, source)
    return resolved !== undefined && isTsFile(resolved) ? resolveExportTarget(graph, load, resolved, exportName) : undefined
  }
  for (const [file, analysis] of [...graph.analyses]) {
    if (NODE_MODULES_RE.test(file) || !analysis.isInteractive)
      continue
    const serverOnly = findCrossFileServerOnly(file, analysis, loadMod, resolveTarget)
    if (serverOnly !== undefined)
      issues.push({ kind: 'server-only-tag', file, serverOnly })
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

  const reportActionExport = (target: string, name: string, offset: number, reexport: boolean): void => {
    const key = `action:${target}:${name}`
    if (!reported.has(key)) {
      reported.add(key)
      issues.push({ kind: 'action-export', file, target, name, offset, reexport })
    }
  }

  const checkSpecifiers = (target: string, targetAnalysis: ModuleAnalysis | undefined, names: readonly string[], offset: number, reexport: boolean): boolean => {
    if (isStubbedActionFile(targetAnalysis)) {
      for (const name of names) {
        if (name !== '*' && !targetAnalysis!.exportedActions.includes(name))
          reportActionExport(target, name, offset, reexport)
      }
      return true
    }
    // Check wildcard-barrel re-exports (`export * from './actions'`), leaving explicit named re-exports to the barrel itself.
    for (const name of names) {
      if (name === '*' || targetAnalysis?.reexports.some(r => r.exported === name) === true)
        continue
      const resolvedTarget = resolveExportTarget(graph, load, target, name)
      if (resolvedTarget !== undefined && resolvedTarget.file !== target) {
        const finalAnalysis = loadTarget(resolvedTarget.file)
        if (isStubbedActionFile(finalAnalysis) && !finalAnalysis!.exportedActions.includes(resolvedTarget.exportName))
          reportActionExport(resolvedTarget.file, resolvedTarget.exportName, offset, reexport)
      }
    }
    return false
  }

  const visitEdge = (source: string, offset: number, reexport: boolean, names: readonly string[]): void => {
    if (isServerOnlyModule(source)) {
      if (checkFileLeaks && !reported.has(source)) {
        reported.add(source)
        issues.push({ kind: 'server-only-import', file, island, source, offset, reexport })
      }
      return
    }
    const target = graph.resolve(file, source)
    if (target === undefined)
      return
    if (target.endsWith('.css')) {
      cssFiles.add(target)
      return
    }
    if (!isTsFile(target))
      return
    if (!checkSpecifiers(target, loadTarget(target), names, offset, reexport))
      enqueue(target, island)
  }

  for (const imp of analysis.imports)
    visitEdge(imp.source, imp.start, false, imp.specifiers.map(s => s.imported))
  for (const re of analysis.reexports)
    visitEdge(re.source, re.start, true, [re.local])
  for (const dyn of analysis.dynamicImports)
    visitEdge(dyn.source, dyn.start, false, [])
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
    // Already reported as `interactive-action`; skip reach checks so we don't emit a contradictory "Move server logic to a server action" error.
    if (!inNodeModules && analysis.isInteractive && analysis.exportedActions.length > 0)
      continue

    const checkFileLeaks = checkLeaks && !inNodeModules
    checkReachEdges(graph, load, file, island, analysis, checkFileLeaks, cssFiles, issues, enqueue)
    if (checkFileLeaks) {
      const envMatch = findPrivateEnv(analysis.program)
      if (envMatch !== undefined)
        issues.push({ kind: 'private-env', file, island, offset: envMatch.offset, envKind: envMatch.kind })
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
  // Reserve 'runtime' so an island named Runtime.tsx never overwrites entriesDir/runtime.ts.
  const usedIds = new Set<string>(['runtime'])
  const pageSet = new Set(pageFiles)

  function registerIsland(file: string, exportName: string): IslandTarget {
    const key = islandKey({ file, exportName })
    const existing = targets.get(key)
    if (existing !== undefined)
      return existing
    const baseName = basename(file, extname(file)).toLowerCase()
    const expLower = exportName.toLowerCase()
    let id = exportName === 'default' || expLower === baseName ? baseName : `${baseName}-${expLower}`
    // The id names the entry file and the chunk: two islands sharing a basename (or 'runtime') keep it readable and add a hash of their path.
    if (usedIds.has(id))
      id = `${id}-${Bun.hash(relPosix(root, key)).toString(36).slice(0, 6)}`
    let suffix = 2
    while (usedIds.has(id))
      id = `${id}-${suffix++}`
    usedIds.add(id)
    const target: IslandTarget = { id, file, exportName, defaultHydrate: load(file)?.defaultHydrate }
    targets.set(key, target)
    return target
  }

  // A component or hook reading reactive state or calling an interactive hook runs in the browser too. The promoted analysis lives in this run's map only, so the cached one still reflects the file alone.
  const { promoteAll, loadPromoted } = createPromoter(graph, load, issues)
  promoteAll()
  checkImportedBareSignals(graph, load, root, issues)
  checkCrossFileServerOnlyTags(graph, load, issues)

  const pageBindings = discoverBindings(graph, load, loadPromoted, pageSet, registerIsland)

  // A layout, error or 404 page renders on the server only, so interactivity written in it would never run.
  for (const file of specialFiles) {
    const page = graph.analyses.get(file)?.exports.get('default')
    if (page?.interactive === true)
      issues.push({ kind: 'special-interactive', file, offset: page.offset ?? 0, reason: page.reason })
  }

  // An interactive module ships to the browser, so co-locating `action()` in it would bundle server action code into the client.
  for (const [file, analysis] of graph.analyses) {
    if (NODE_MODULES_RE.test(file) || !analysis.isInteractive || analysis.exportedActions.length === 0)
      continue
    const name = analysis.exportedActions[0]!
    const offset = analysis.bindings.find(b => b.name === name)?.start ?? 0
    const reason = [...analysis.exports.values()].find(e => e.interactive)?.reason
      ?? analysis.bindings.find(b => b.fact !== undefined)?.fact?.reason
    issues.push({ kind: 'interactive-action', file, name, offset, reason })
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
    if (issue.kind === 'interactive-action')
      throw new Error(`kay build: ${rel} exports server action "${issue.name}" and also uses browser interactivity${issue.reason ? ` (${issue.reason})` : ''}: server action code would leak into the browser bundle. Move "${issue.name}" into a separate non-interactive file (e.g. a .ts actions module).`)
    if (issue.kind === 'action-export') {
      const verb = issue.reexport ? 're-exports' : 'imports'
      throw new Error(`kay build: ${rel} runs in the browser and ${verb} ${issue.name} from ${relPosix(root, issue.target)}, a file of server actions: the browser only gets its actions. Move ${issue.name} into a module without actions.`)
    }
    if (issue.kind === 'server-only-import')
      leaks.add(issue.reexport ? `${rel} re-exports from server-only module "${issue.source}"` : `${rel} imports server-only module "${issue.source}"`)
    if (issue.kind === 'compiler-mistake')
      throw new Error(issue.message)
    if (issue.kind === 'private-env')
      leaks.add(`${rel} reads process.env or Bun.env (only a process.env.PUBLIC_* set at build time is inlined)`)
  }
  if (leaks.size > 0)
    throw clientLeakError(leaks)
  return plan
}
