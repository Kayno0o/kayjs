// Which exports of a module run in the browser: facts gathered per top-level binding, spread through the local calls between them. A local component rendered as a tag is an island of its own instead.

import type { ImportInfo } from './analyze'

export interface Fact {
  reason: string
  offset: number
}

export interface BindingFacts {
  /** The top-level name, `default` for an anonymous default export, or '' for module-level code. */
  name: string
  start: number
  end: number
  /** The first thing its own code does that needs the browser. */
  fact: Fact | undefined
  /** Top-level bindings and imports its code names (including JSX tags), each at its first use. */
  refs: Map<string, number>
  /** Top-level bindings and imports referenced in value expressions (excluding JSX tag names), each at its first use. */
  valueRefs: Map<string, number>
  /** Non-computed member names read from a value reference (`S.count` -> `'count'`), or `'*'` when read bare. */
  memberRefs: Map<string, Set<string>>
  /** Component tags it renders, `NS.Tag` included. */
  tags: Set<string>
  /** The first `<Head>`, `<Region>`, or `<Suspense>` it renders. */
  serverOnlyTag: string | undefined
}

export interface ExportFacts {
  interactive: boolean
  /** Why it runs in the browser, e.g. `uses onClick`. */
  reason?: string | undefined
  offset?: number | undefined
}

export interface Interactivity {
  /** Some binding or module-level code runs in the browser. */
  isInteractive: boolean
  /** The first reason in source order. */
  interactiveReason: string | undefined
  interactiveOffset: number | undefined
  exports: Map<string, ExportFacts>
  /** Top-level components that run in the browser and are rendered as a tag by server code of the same module: each is an island of its own. */
  localIslands: Map<string, Fact>
  /** Component tags rendered by code that runs on the server: the ones an imported island can stand for. */
  staticJsxTags: Set<string>
  /** Spans of code that only runs inside an island, where an imported island is part of the outer one. */
  islandSpans: [number, number][]
  /** Spans of code that may run in the browser: each binding that runs there and every local binding it reaches, whose HTML hydration claims. */
  browserSpans: [number, number][]
  /** An island rendering `<Head>` or `<Suspense>`, itself or through a local component. */
  serverOnly: ServerOnlyInIsland | undefined
}

export interface ServerOnlyInIsland {
  tag: string
  /** The island's name, `the default export` or `the module` when it has none. */
  island: string
  reason: string
  offset: number
}

/** `reads` maps imported locals to a reason, `reads count from './store'` for reactive state another module exports. */
export function resolveInteractivity(bindings: readonly BindingFacts[], exportLocals: ReadonlyMap<string, string>, reads: ReadonlyMap<string, string> = new Map()): Interactivity {
  const named = new Map<string, BindingFacts>()
  for (const b of bindings) {
    if (b.name !== '')
      named.set(b.name, b)
  }
  const facts = spreadFacts(bindings, named, reads)

  const exported = new Set(exportLocals.values())
  const serverSide = new Set<BindingFacts>()
  const stack = bindings.filter(b => !facts.has(b) && (b.name === '' || exported.has(b.name)))
  for (let b = stack.pop(); b !== undefined; b = stack.pop()) {
    if (serverSide.has(b))
      continue
    serverSide.add(b)
    for (const ref of b.refs.keys()) {
      const dep = named.get(ref)
      if (dep !== undefined && !facts.has(dep))
        stack.push(dep)
    }
  }

  const exports = new Map<string, ExportFacts>()
  for (const [name, local] of exportLocals) {
    const binding = named.get(local)
    const fact = binding === undefined ? undefined : facts.get(binding)
    exports.set(name, fact === undefined ? { interactive: false } : { interactive: true, reason: fact.reason, offset: fact.offset })
  }
  const staticJsxTags = new Set([...serverSide].flatMap(b => [...b.tags]))
  const localIslands = new Map<string, Fact>()
  for (const [binding, fact] of facts) {
    if (binding.name !== '' && staticJsxTags.has(binding.name))
      localIslands.set(binding.name, fact)
  }
  const first = bindings.find(b => facts.has(b))
  const firstFact = first === undefined ? undefined : facts.get(first)
  return {
    isInteractive: facts.size > 0,
    interactiveReason: firstFact?.reason,
    interactiveOffset: firstFact?.offset,
    exports,
    localIslands,
    staticJsxTags,
    islandSpans: bindings.filter(b => !serverSide.has(b)).map(b => [b.start, b.end]),
    browserSpans: [...reachedFrom([...facts.keys()], named)].map(b => [b.start, b.end]),
    serverOnly: serverOnlyInIsland(bindings, named, facts),
  }
}

function spreadFacts(bindings: readonly BindingFacts[], named: ReadonlyMap<string, BindingFacts>, reads: ReadonlyMap<string, string>): Map<BindingFacts, Fact> {
  const facts = new Map<BindingFacts, Fact>()
  let moduleFact: Fact | undefined
  for (const b of bindings) {
    let own = b.fact
    for (const [ref, offset] of b.valueRefs) {
      if (own !== undefined)
        break
      const reason = reads.get(ref)
      if (reason !== undefined) {
        own = { reason, offset }
        continue
      }
      const members = b.memberRefs.get(ref)
      if (members !== undefined) {
        for (const m of members) {
          const mReason = reads.get(`${ref}.${m}`)
          if (mReason !== undefined) {
            own = { reason: mReason, offset }
            break
          }
        }
      }
    }
    if (own !== undefined)
      facts.set(b, own)
    if (b.name === '')
      moduleFact ??= own
  }
  // Module-level code that needs the browser runs with every island of the module, so every binding gets its reason.
  if (moduleFact !== undefined) {
    for (const b of named.values()) {
      if (!facts.has(b))
        facts.set(b, moduleFact)
    }
  }
  // A binding calling or reading an interactive one runs in the browser too; repeat until nothing changes. Rendering one as `<Tag />` does not: the tag becomes an island of its own.
  for (let changed = true; changed;) {
    changed = false
    for (const b of named.values()) {
      if (facts.has(b))
        continue
      for (const [ref, offset] of b.refs) {
        if (b.tags.has(ref) && !b.valueRefs.has(ref))
          continue
        const dep = named.get(ref)
        const depFact = dep === undefined ? undefined : facts.get(dep)
        if (depFact !== undefined) {
          facts.set(b, { reason: `uses ${ref}, which ${depFact.reason}`, offset })
          changed = true
          break
        }
      }
    }
  }
  return facts
}

function serverOnlyInIsland(bindings: readonly BindingFacts[], named: ReadonlyMap<string, BindingFacts>, facts: ReadonlyMap<BindingFacts, Fact>): Interactivity['serverOnly'] {
  for (const island of bindings) {
    const fact = facts.get(island)
    if (fact === undefined)
      continue
    const seen = new Set<BindingFacts>()
    const stack = [island]
    for (let b = stack.pop(); b !== undefined; b = stack.pop()) {
      if (seen.has(b))
        continue
      seen.add(b)
      if (b.serverOnlyTag !== undefined) {
        const name = island.name === '' ? 'the module' : island.name === 'default' ? 'the default export' : island.name
        return { tag: b.serverOnlyTag, island: name, reason: fact.reason, offset: fact.offset }
      }
      for (const ref of b.refs.keys()) {
        const dep = named.get(ref)
        if (dep !== undefined)
          stack.push(dep)
      }
    }
  }
  return undefined
}

/** The module re-resolved once its imports of other modules' reactive state or hooks are known, or `undefined` when it imports none. */
export function withStateReads(analysis: { imports: ImportInfo[], jsxTags: Set<string>, bindings: BindingFacts[], exportLocals: Map<string, string> }, isState: (imp: ImportInfo, imported: string) => boolean): Interactivity | undefined {
  const reads = new Map<string, string>()
  const allValueRefs = new Set<string>()
  const allMemberRefs = new Map<string, Set<string>>()
  for (const b of analysis.bindings) {
    for (const ref of b.valueRefs.keys())
      allValueRefs.add(ref)
    for (const [ref, members] of b.memberRefs) {
      let set = allMemberRefs.get(ref)
      if (set === undefined) {
        set = new Set()
        allMemberRefs.set(ref, set)
      }
      for (const m of members)
        set.add(m)
    }
  }
  for (const imp of analysis.imports) {
    for (const spec of imp.specifiers) {
      if (!allValueRefs.has(spec.local))
        continue
      if (spec.imported === '*') {
        const members = allMemberRefs.get(spec.local)
        if (members === undefined)
          continue
        for (const m of members) {
          if (isState(imp, m))
            reads.set(`${spec.local}.${m}`, `reads ${spec.local} from '${imp.source}'`)
        }
      }
      else if (isState(imp, spec.imported)) {
        reads.set(spec.local, `reads ${spec.local} from '${imp.source}'`)
      }
    }
  }
  return reads.size === 0 ? undefined : resolveInteractivity(analysis.bindings, analysis.exportLocals, reads)
}

export interface CrossFileModuleLike {
  isInteractive: boolean
  imports: ImportInfo[]
  bindings: BindingFacts[]
  exportLocals: Map<string, string>
  exports: Map<string, ExportFacts>
}

/** The `roots` and every top-level binding their code names, transitively. */
function reachedFrom(roots: readonly BindingFacts[], named: ReadonlyMap<string, BindingFacts>): Set<BindingFacts> {
  const seen = new Set<BindingFacts>()
  const stack = [...roots]
  for (let b = stack.pop(); b !== undefined; b = stack.pop()) {
    if (seen.has(b))
      continue
    seen.add(b)
    for (const ref of b.refs.keys()) {
      const dep = named.get(ref)
      if (dep !== undefined)
        stack.push(dep)
    }
  }
  return seen
}

/** What the browser runs of a module for the islands `localNames`: those bindings, the module-level code, and every binding they reach. */
export function clientReach(bindings: readonly BindingFacts[], localNames: readonly string[]): BindingFacts[] {
  return localReach(bindings, localNames, bindings.filter(b => b.name === ''))
}

/** The top-level bindings named `localNames`, and every binding they reach. */
function localReach(bindings: readonly BindingFacts[], localNames: readonly string[], extraRoots: readonly BindingFacts[] = []): BindingFacts[] {
  const named = new Map<string, BindingFacts>()
  for (const b of bindings) {
    if (b.name !== '')
      named.set(b.name, b)
  }
  return [...reachedFrom([...extraRoots, ...localNames.flatMap(name => named.get(name) ?? [])], named)]
}

function importedTargetsOf(
  file: string,
  analysis: CrossFileModuleLike,
  bindings: readonly BindingFacts[],
  resolveTarget: (fromFile: string, source: string, exportName: string) => { file: string, exportName: string } | undefined,
): { file: string, exportName: string, offset: number }[] {
  const out: { file: string, exportName: string, offset: number }[] = []
  for (const imp of analysis.imports) {
    for (const spec of imp.specifiers) {
      for (const b of bindings) {
        if (spec.imported === '*') {
          const members = new Set<string>()
          for (const tag of b.tags) {
            if (tag.startsWith(`${spec.local}.`))
              members.add(tag.slice(spec.local.length + 1).split('.')[0]!)
          }
          for (const m of b.memberRefs.get(spec.local) ?? []) {
            if (m !== '*')
              members.add(m)
          }
          const offset = b.refs.get(spec.local) ?? b.start
          for (const member of members) {
            const target = resolveTarget(file, imp.source, member)
            if (target !== undefined)
              out.push({ file: target.file, exportName: target.exportName, offset })
          }
        }
        else {
          const offset = b.refs.get(spec.local)
          if (offset !== undefined) {
            const target = resolveTarget(file, imp.source, spec.imported)
            if (target !== undefined)
              out.push({ file: target.file, exportName: target.exportName, offset })
          }
        }
      }
    }
  }
  return out
}

/** Finds `<Head>`, `<Region>`, or `<Suspense>` rendered across file boundaries by an interactive export of `file`. */
export function findCrossFileServerOnly(
  file: string,
  analysis: CrossFileModuleLike,
  loadModule: (file: string) => CrossFileModuleLike | undefined,
  resolveTarget: (fromFile: string, source: string, exportName: string) => { file: string, exportName: string } | undefined,
): ServerOnlyInIsland | undefined {
  if (!analysis.isInteractive)
    return undefined
  for (const [exportName, expFact] of analysis.exports) {
    if (!expFact.interactive)
      continue
    const local = analysis.exportLocals.get(exportName)
    if (local === undefined)
      continue
    const startBindings = localReach(analysis.bindings, [local])
    const visited = new Set<string>()
    const findInTarget = (tFile: string, tExport: string): string | undefined => {
      const key = `${tFile}\0${tExport}`
      if (visited.has(key))
        return undefined
      visited.add(key)
      const a = loadModule(tFile)
      if (a === undefined)
        return undefined
      const tLocal = a.exportLocals.get(tExport)
      if (tLocal === undefined)
        return undefined
      const reached = localReach(a.bindings, [tLocal])
      const hit = reached.find(b => b.serverOnlyTag !== undefined)
      if (hit !== undefined)
        return hit.serverOnlyTag
      for (const next of importedTargetsOf(tFile, a, reached, resolveTarget)) {
        const nested = findInTarget(next.file, next.exportName)
        if (nested !== undefined)
          return nested
      }
      return undefined
    }
    for (const next of importedTargetsOf(file, analysis, startBindings, resolveTarget)) {
      if (next.file === file)
        continue
      const tag = findInTarget(next.file, next.exportName)
      if (tag !== undefined) {
        const island = local === 'default' ? 'the default export' : local
        return { tag, island, reason: expFact.reason ?? 'is interactive', offset: next.offset }
      }
    }
  }
  return undefined
}
