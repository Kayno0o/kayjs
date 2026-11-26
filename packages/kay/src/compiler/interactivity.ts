// Which exports of a module run in the browser: facts gathered per top-level binding, spread through the local calls and tags between them.

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
  /** Top-level bindings and imports its code names, each at its first use. */
  refs: Map<string, number>
  /** Component tags it renders, `NS.Tag` included. */
  tags: Set<string>
  /** The first `<Head>` or `<Suspense>` it renders. */
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
  /** Component tags rendered by code that runs on the server: the ones an imported island can stand for. */
  staticJsxTags: Set<string>
  /** Spans of code that only runs inside an island, where an imported island is part of the outer one. */
  islandSpans: [number, number][]
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
  const first = bindings.find(b => facts.has(b))
  const firstFact = first === undefined ? undefined : facts.get(first)
  return {
    isInteractive: facts.size > 0,
    interactiveReason: firstFact?.reason,
    interactiveOffset: firstFact?.offset,
    exports,
    staticJsxTags: new Set([...serverSide].flatMap(b => [...b.tags])),
    islandSpans: bindings.filter(b => !serverSide.has(b)).map(b => [b.start, b.end]),
    serverOnly: serverOnlyInIsland(bindings, named, facts),
  }
}

function spreadFacts(bindings: readonly BindingFacts[], named: ReadonlyMap<string, BindingFacts>, reads: ReadonlyMap<string, string>): Map<BindingFacts, Fact> {
  const facts = new Map<BindingFacts, Fact>()
  let moduleFact: Fact | undefined
  for (const b of bindings) {
    let own = b.fact
    for (const [ref, offset] of b.refs) {
      const reason = own === undefined ? reads.get(ref) : undefined
      if (reason !== undefined)
        own = { reason, offset }
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
  // A binding calling or rendering an interactive one runs in the browser too; repeat until nothing changes.
  for (let changed = true; changed;) {
    changed = false
    for (const b of named.values()) {
      if (facts.has(b))
        continue
      for (const [ref, offset] of b.refs) {
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

/** The module re-resolved once its imports of other modules' reactive state are known, or `undefined` when it imports none. */
export function withStateReads(analysis: { imports: ImportInfo[], jsxTags: Set<string>, bindings: BindingFacts[], exportLocals: Map<string, string> }, isState: (imp: ImportInfo, imported: string) => boolean): Interactivity | undefined {
  const reads = new Map<string, string>()
  for (const imp of analysis.imports) {
    for (const spec of imp.specifiers) {
      if (!analysis.jsxTags.has(spec.local) && isState(imp, spec.imported))
        reads.set(spec.local, `reads ${spec.local} from '${imp.source}'`)
    }
  }
  return reads.size === 0 ? undefined : resolveInteractivity(analysis.bindings, analysis.exportLocals, reads)
}
