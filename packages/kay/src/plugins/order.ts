// Plugin ordering: `enforce` buckets, `after` dependencies, and the `readsLocals`/`providesLocals` startup check.

import type { KayPlugin } from './types'
import { closestName } from './config'

function enforceRank(plugin: KayPlugin): number {
  return plugin.enforce === 'pre' ? 0 : plugin.enforce === 'post' ? 2 : 1
}

/**
 * Sorts plugins stably by `enforce` (`'pre'` -> normal -> `'post'`) and `after` dependencies,
 * then fails fast if any plugin declares `readsLocals` for a key whose provider runs after it.
 */
export function resolvePlugins(plugins: readonly KayPlugin[] | undefined): KayPlugin[] {
  if (plugins === undefined || plugins.length === 0)
    return []

  // Base stable order by `enforce` bucket, preserving config declaration order within each bucket.
  const base = plugins
    .map((plugin, index) => ({ plugin, index, rank: enforceRank(plugin) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.plugin)

  const n = base.length
  // `after` lists and `manifest.pluginData` both find a plugin by its name, so two plugins sharing one would trample each other.
  const indexByName = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const name = base[i]!.name
    if (indexByName.has(name))
      throw new Error(`kay: two plugins are named "${name}" in kay.config.ts: register it once, or give each instance its own \`name\`.`)
    indexByName.set(name, i)
  }
  const names = [...indexByName.keys()]

  // Kahn's topological sort using min-index priority so `enforce` + declaration order stays deterministic.
  const inDegree = new Int32Array(n)
  const edges: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const deps = base[i]!.after
    if (deps === undefined)
      continue
    const seen = new Set<number>()
    for (const depName of deps) {
      const depIdx = indexByName.get(depName)
      // A name no plugin has is an optional dependency that is not installed, unless it is one typo away from one that is.
      if (depIdx === undefined) {
        const near = closestName(depName, names)
        if (near !== undefined)
          throw new Error(`kay: plugin "${base[i]!.name}" runs \`after\` "${depName}", which no plugin is named: did you mean "${near}"?`)
        continue
      }
      if (depIdx === i || seen.has(depIdx))
        continue
      seen.add(depIdx)
      edges[depIdx]!.push(i)
      inDegree[i] = (inDegree[i] ?? 0) + 1
    }
  }

  const ready: number[] = []
  for (let i = 0; i < n; i++) {
    if (inDegree[i] === 0)
      ready.push(i)
  }

  const sorted: KayPlugin[] = []
  while (ready.length > 0) {
    // Pick lowest base index so `enforce` and user declaration order are preserved whenever unconstrained.
    let bestPos = 0
    for (let k = 1; k < ready.length; k++) {
      if (ready[k]! < ready[bestPos]!)
        bestPos = k
    }
    const u = ready.splice(bestPos, 1)[0]!
    sorted.push(base[u]!)
    for (const v of edges[u]!) {
      inDegree[v] = (inDegree[v] ?? 0) - 1
      if (inDegree[v] === 0)
        ready.push(v)
    }
  }

  if (sorted.length !== n) {
    const stuck = base.filter((_, idx) => (inDegree[idx] ?? 0) > 0).map(p => p.name)
    throw new Error(`kay: circular plugin \`after\` dependency involving: ${stuck.join(', ')}`)
  }

  // Validate that no plugin reads a ctx.locals key before another active plugin provides it.
  const providerByLocal = new Map<string, { name: string, index: number }>()
  for (let i = 0; i < sorted.length; i++) {
    const plugin = sorted[i]!
    for (const key of plugin.providesLocals ?? []) {
      if (!providerByLocal.has(key))
        providerByLocal.set(key, { name: plugin.name, index: i })
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const plugin = sorted[i]!
    for (const key of plugin.readsLocals ?? []) {
      const provider = providerByLocal.get(key)
      if (provider !== undefined && provider.index > i) {
        throw new Error(
          `kay: plugin "${plugin.name}" reads ctx.locals.${key} before "${provider.name}" provides it. Add \`after: [${JSON.stringify(provider.name)}]\` or adjust plugin order.`,
        )
      }
    }
  }

  return sorted
}
