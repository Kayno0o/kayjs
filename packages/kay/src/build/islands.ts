// Island discovery: which exports run in the browser, which modules render them, and the checks that keep server code out of them.

import type { ModuleGraph } from './graph'
import { basename, extname } from 'node:path'
import { asyncInteractiveError } from '../compiler/analyze'
import { withStateReads } from '../compiler/interactivity'
import { serverOnlyTagError } from '../compiler/mistakes'
import { isTsFile, relPosix } from './files'

export interface IslandTarget {
  id: string
  file: string
  exportName: string
  defaultHydrate: string | undefined
}

export type ActionsByFile = Map<string, { exportName: string, url: string }[]>

export interface IslandPlan {
  /** Island roots keyed `file#exportName`. */
  targets: Map<string, IslandTarget>
  /** Per static module, the island each rendered tag stands for. */
  pageBindings: Map<string, Map<string, IslandTarget>>
  /** CSS files imported (transitively) by an island: bundled with it, not as standalone styles. */
  cssFiles: Set<string>
  /** Modules the client compiles for an island, whose SSR must emit hydration markers too. */
  reach: Set<string>
}

export function islandKey(target: { file: string, exportName: string }): string {
  return `${target.file}#${target.exportName}`
}

export function planIslands(graph: ModuleGraph, root: string, pageFiles: string[], specialFiles: string[], actionsByFile: ActionsByFile): IslandPlan {
  const { analyses } = graph
  const targets = new Map<string, IslandTarget>()
  const usedIds = new Set<string>()
  const pageBindings = new Map<string, Map<string, IslandTarget>>()
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
    const target: IslandTarget = { id, file, exportName, defaultHydrate: graph.load(file).defaultHydrate }
    targets.set(key, target)
    return target
  }

  // A component reading reactive state another module exports runs in the browser too. The promoted analysis lives in this build's map only, so the cached one still reflects the file alone.
  for (const [file, analysis] of analyses) {
    if (!file.endsWith('.tsx'))
      continue
    const promoted = withStateReads(analysis, (imp, imported) => {
      const resolved = graph.resolve(file, imp.source)
      if (resolved === undefined || !isTsFile(resolved))
        return false
      if (imported === '*')
        return graph.load(resolved).stateExports.length > 0
      const target = graph.exportTarget(resolved, imported)
      return graph.load(target.file).stateExports.includes(target.exportName)
    })
    if (promoted === undefined)
      continue
    const page = promoted.exports.get('default')
    if (analysis.hasAsyncDefault && page?.interactive === true)
      throw asyncInteractiveError(file, page.reason)
    if (promoted.serverOnly !== undefined)
      throw serverOnlyTagError(relPosix(root, file), promoted.serverOnly)
    analyses.set(file, { ...analysis, ...promoted })
  }

  for (const [file, analysis] of analyses) {
    if (!file.endsWith('.tsx'))
      continue
    if (analysis.exports.get('default')?.interactive === true && pageSet.has(file)) {
      registerIsland(file, 'default')
      continue
    }

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
          const target = graph.exportTarget(resolved, exportName)
          if (target.file.endsWith('.tsx') && graph.load(target.file).exports.get(target.exportName)?.interactive === true)
            bindings.set(tag, registerIsland(target.file, target.exportName))
        }
      }
    }
    if (bindings.size > 0)
      pageBindings.set(file, bindings)
  }

  const isStubbedActionFile = (file: string): boolean =>
    !analyses.get(file)?.isInteractive && actionsByFile.has(file)

  // Component/page CSS & CSS Module imports reached from islands are bundled via island entrypoints.
  const cssFiles = new Set<string>()
  const cssSeen = new Set<string>()
  const cssStack = [...targets.values()].map(t => t.file)
  while (cssStack.length > 0) {
    const file = cssStack.pop()!
    if (cssSeen.has(file))
      continue
    cssSeen.add(file)
    for (const imp of analyses.get(file)?.imports ?? []) {
      const target = graph.resolve(file, imp.source)
      if (target === undefined)
        continue
      if (target.endsWith('.css'))
        cssFiles.add(target)
      else if (isTsFile(target) && !isStubbedActionFile(target))
        cssStack.push(target)
    }
  }

  // A layout, error or 404 page renders on the server only, so interactivity written in it would never run.
  for (const file of specialFiles) {
    const page = analyses.get(file)?.exports.get('default')
    if (page?.interactive === true) {
      const rel = relPosix(root, file)
      throw new Error(`kay build: ${rel} uses browser interactivity (${page.reason}), but it renders on the server only. Move the interactive part into a component and render that component from ${rel}.`)
    }
  }

  // The client compiles every module an island imports to hydrate against SSR markers, so their SSR must emit them too.
  const reach = new Set<string>()
  const reachSeen = new Set<string>()
  const reachStack = [...targets.values()].map(t => t.file)
  while (reachStack.length > 0) {
    const file = reachStack.pop()!
    if (reachSeen.has(file))
      continue
    reachSeen.add(file)
    if (file.endsWith('.tsx'))
      reach.add(file)
    for (const dep of graph.localDeps(file)) {
      if (!isStubbedActionFile(dep))
        reachStack.push(dep)
    }
    const analysis = analyses.get(file)
    for (const imp of analysis?.imports ?? []) {
      // The client build swaps an action file for stubs of its actions, so any other export it has is missing there.
      const target = graph.resolve(file, imp.source)
      const actions = target !== undefined && isStubbedActionFile(target) ? actionsByFile.get(target) : undefined
      const missing = actions !== undefined ? imp.specifiers.find(s => s.imported !== '*' && !actions.some(a => a.exportName === s.imported)) : undefined
      if (missing !== undefined)
        throw new Error(`kay build: ${relPosix(root, file)} runs in the browser and imports ${missing.imported} from ${relPosix(root, target!)}, a file of server actions: the browser only gets its actions. Move ${missing.imported} into a module without actions.`)
    }
    for (const re of analysis?.reexports ?? []) {
      const target = graph.resolve(file, re.source)
      const actions = target !== undefined && isStubbedActionFile(target) ? actionsByFile.get(target) : undefined
      if (actions !== undefined && re.local !== '*' && !actions.some(a => a.exportName === re.local))
        throw new Error(`kay build: ${relPosix(root, file)} runs in the browser and re-exports ${re.local} from ${relPosix(root, target!)}, a file of server actions: the browser only gets its actions. Move ${re.local} into a module without actions.`)
    }
  }

  return { targets, pageBindings, cssFiles, reach }
}
