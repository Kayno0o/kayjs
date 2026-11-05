import type { ElementNode, KayFile, Node, Span } from './ast'
import type { BodyFact } from './load-facts'
import type { ServerAnalysis } from './script-server'
import { isHead, nodeExpressions } from './ast'
import { codeOf } from './script'
import { binders, bindingNames, readNames, scopedBlocks } from './template-reads'

// The table the runtime reads (`LoadTable` in `src/runtime/load-scope.ts`), as written into the module.
export interface LoadPlan {
  table: string
  // How each guardable statement of the fence runs: the ids of the loads it needs.
  needs: Map<Span, number[]>
  // The group of each element reading loads, by where it starts.
  groups: Map<number, number>
}

// A tag the browser does not render in the body, or one whose attributes and children belong to the page as a whole.
const WHOLE_PAGE = new Set(['html', 'body', 'head', 'title', 'meta', 'link', 'base', 'style', 'script', 'template', 'noscript', 'slot'])
const TAG = /^[a-z][a-z0-9-]*$/i

interface Unit {
  element: ElementNode
  parent: Unit | undefined
  direct: Set<number>
  subtree: Set<number>
}

// Which loads of a fence a refresh can leave out, when the fence has any: a load is a top-level `const name = await ...` (or a pattern of names), named after the names it declares.
// An element whose markup reads none of the loads a refresh runs is left to the page as it is, so its loads are never called; what reads loads outside any element, or in `head`, makes them run.
export function planLoads(file: KayFile, server: ServerAnalysis): LoadPlan | undefined {
  const text = (span: Span) => file.source.slice(span.start, span.end)
  // What each name of the fence depends on: the loads that make its value.
  const dependsOn = new Map<string, number[]>()
  const loads: { names: string[], needs: Set<number> }[] = []
  const needs = new Map<Span, number[]>()
  const pinned = new Set<number>()

  const reads = (words: readonly string[]) => new Set(words.flatMap(word => dependsOn.get(word) ?? []))

  for (const span of server.body) {
    const fact: BodyFact | undefined = server.facts.get(span)

    if (fact === undefined)
      continue

    const roots = reads(fact.words)

    if (fact.guard?.kind === 'declaration' && fact.awaits) {
      const id = loads.length

      loads.push({ names: fact.declared, needs: new Set(roots) })

      for (const name of fact.declared)
        dependsOn.set(name, [id])

      needs.set(span, [id])
    }
    else if (fact.guard !== undefined) {
      for (const name of fact.declared)
        dependsOn.set(name, [...roots])

      if (roots.size > 0)
        needs.set(span, [...roots])
    }
    else {
      // A statement that cannot be left out runs for every refresh, and so does what it reads.
      for (const name of fact.declared)
        dependsOn.set(name, [...roots])

      for (const id of roots)
        pinned.add(id)
    }
  }

  if (loads.length === 0)
    return undefined

  // A script reads the fence's values as it renders.
  for (const fence of [file.script, file.module]) {
    if (fence === undefined)
      continue

    for (const id of reads(text(fence).match(/(?<![\w$.])[A-Z_$][\w$]*/gi) ?? []))
      pinned.add(id)
  }

  const units: Unit[] = []
  const touch = (names: Iterable<string>, owner: Unit | 'page' | undefined) => {
    for (const id of reads([...names])) {
      if (owner === undefined || owner === 'page') {
        pinned.add(id)

        continue
      }

      owner.direct.add(id)

      for (let unit: Unit | undefined = owner; unit; unit = unit.parent)
        unit.subtree.add(id)
    }
  }

  const walk = (nodes: readonly Node[], scope: ReadonlySet<string>, owner: Unit | 'page' | undefined): void => {
    const here = new Set(scope)

    for (const node of nodes) {
      const own = binders(node)
      let inner = owner

      if (node.kind === 'element' && !node.component && !WHOLE_PAGE.has(node.name) && !isHead(node) && TAG.test(node.name) && node.outlet === undefined && node.fills === undefined && owner !== 'page') {
        inner = { element: node, parent: owner, direct: new Set(), subtree: new Set() }
        units.push(inner)
      }
      else if (isHead(node)) {
        inner = 'page'
      }

      for (const span of nodeExpressions(node)) {
        if (own.includes(span))
          continue

        touch([...readNames(codeOf(text(span)))].filter(name => !here.has(name)), inner)
      }

      if (node.kind === 'const') {
        for (const name of bindingNames(text(node.pattern)))
          here.add(name)

        continue
      }

      for (const [block, spans] of scopedBlocks(node))
        walk(block, new Set([...here, ...spans.flatMap(span => bindingNames(text(span)))]), inner)
    }
  }

  walk(file.template, new Set(), undefined)

  const groups = new Map<number, number>()
  const listed: [number[], number[]][] = []
  const known = new Map<string, number>()

  for (const unit of units) {
    if (unit.subtree.size === 0)
      continue

    const entry: [number[], number[]] = [[...unit.subtree].toSorted((a, b) => a - b), [...unit.direct].toSorted((a, b) => a - b)]
    const key = JSON.stringify(entry)
    let id = known.get(key)

    if (id === undefined) {
      id = listed.push(entry) - 1
      known.set(key, id)
    }

    groups.set(unit.element.start, id)
  }

  const names = new Map<string, number[]>()

  for (const [name, ids] of dependsOn)
    names.set(name, ids)

  const table = JSON.stringify({
    names: [...names].filter(([name]) => server.data.some(data => data.name === name)).map(([name, ids]) => [name, [...new Set(ids)]]),
    needs: loads.map(load => [...load.needs]),
    pinned: [...pinned],
    groups: listed,
  })

  return { table, needs, groups }
}
