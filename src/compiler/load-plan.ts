import type { ElementNode, KayFile, Node, Span } from './ast'
import type { BodyFact } from './load-facts'
import type { ServerAnalysis } from './script-server'
import { isHead, nodeExpressions } from './ast'
import { WORD } from './load-facts'
import { codeOf } from './script'
import { binders, bindingNames, readNames, scopedBlocks } from './template-reads'

// The table the runtime reads (`LoadTable` in `src/runtime/load-scope.ts`), as written into the module.
export interface LoadPlan {
  table: string
  // How each guardable statement of the fence runs: the ids of the loads it needs.
  needs: Map<Span, number[]>
  // The group of each element reading loads, by where it starts, with the id the element carries so a refresh finds it again.
  groups: Map<number, { group: number, id: string }>
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

// A short tag of the file, so the ids of the units of a page and of its layouts never meet.
function fileTag(text: string): string {
  let hash = 0

  for (const char of text)
    hash = Math.imul(hash, 31) + char.charCodeAt(0) | 0

  return (hash >>> 0).toString(36)
}

const holdsOutlets = new WeakMap<Node, boolean>()

// Whether the node is, or has inside it, the place a layout renders its page or a named slot: such an element is never left to the page as it is.
function holdsOutlet(node: Node): boolean {
  const known = holdsOutlets.get(node)

  if (known !== undefined)
    return known

  const found = node.kind === 'slot' || (node.kind === 'element' && (node.outlet !== undefined || (node.name === 'slot' && !node.component))) || scopedBlocks(node).some(([block]) => block.some(holdsOutlet))

  holdsOutlets.set(node, found)

  return found
}

// Which loads of a fence a refresh can leave out, when the fence has any: a load is a top-level `const name = await ...` (or a pattern of names), named after the names it declares.
// An element outside any block of the template, whose markup reads none of the loads a refresh runs, is left to the page as it is, so its loads are never called; what reads loads outside such an element, in `head`, or in a script makes them run.
export function planLoads(file: KayFile, server: ServerAnalysis, moduleId: string): LoadPlan | undefined {
  const text = (span: Span) => file.source.slice(span.start, span.end)
  const declared = new Set<string>()

  for (const span of server.body) {
    for (const name of server.facts.get(span)?.declared ?? [])
      declared.add(name)
  }

  // What each name of the fence depends on: the loads that make it, and the names whose values it is made of or is changed with.
  const base = new Map<string, number[]>()
  const edges = new Map<string, Set<string>>()
  const loads: { words: string[] }[] = []
  const guarded: { span: Span, words: string[], load?: number }[] = []
  const unguarded: string[][] = []

  const link = (name: string, words: readonly string[]) => {
    const set = edges.get(name) ?? new Set<string>()

    for (const word of words) {
      if (declared.has(word))
        set.add(word)
    }

    edges.set(name, set)
  }

  for (const span of server.body) {
    const fact: BodyFact | undefined = server.facts.get(span)

    if (fact === undefined)
      continue

    if (fact.guard?.kind === 'declaration' && fact.awaits) {
      const id = loads.push({ words: fact.words }) - 1

      for (const name of fact.declared)
        base.set(name, [id])

      guarded.push({ span, words: fact.words, load: id })
    }
    else if (fact.guard?.kind === 'declaration') {
      for (const name of fact.declared)
        link(name, fact.words)

      guarded.push({ span, words: fact.words })
    }
    else if (fact.guard !== undefined) {
      // A statement changes whatever it mentions: those names then depend on what the statement reads.
      for (const word of fact.words) {
        if (declared.has(word))
          link(word, fact.words)
      }

      guarded.push({ span, words: fact.words })
    }
    else {
      for (const name of fact.declared)
        link(name, fact.words)

      unguarded.push(fact.words)
    }
  }

  if (loads.length === 0)
    return undefined

  const closure = (name: string, seen = new Set<string>()): number[] => {
    if (seen.has(name))
      return []

    seen.add(name)

    return [...base.get(name) ?? [], ...[...edges.get(name) ?? []].flatMap(next => closure(next, seen))]
  }

  const readIds = (words: readonly string[]) => new Set(words.flatMap(word => closure(word)))

  const needs = new Map<Span, number[]>()

  for (const { span, words, load } of guarded) {
    if (load !== undefined) {
      needs.set(span, [load])

      continue
    }

    const roots = readIds(words)

    if (roots.size > 0)
      needs.set(span, [...roots])
  }

  const needed = loads.map(load => readIds(load.words))
  // A statement that cannot be left out runs for every refresh, and so does what it reads.
  const pinned = new Set<number>(unguarded.flatMap(words => [...readIds(words)]))

  // A script reads the fence's values as it renders.
  for (const fence of [file.script, file.module]) {
    if (fence === undefined)
      continue

    for (const id of readIds(text(fence).match(WORD) ?? []))
      pinned.add(id)
  }

  const units: Unit[] = []

  type Scope = ReadonlyMap<string, ReadonlySet<number>>

  const idsOf = (names: Iterable<string>, scope: Scope): Set<number> => {
    const ids = new Set<number>()

    for (const name of names) {
      const local = scope.get(name)

      for (const id of local ?? closure(name))
        ids.add(id)
    }

    return ids
  }

  const touch = (ids: ReadonlySet<number>, owner: Unit | 'page' | undefined) => {
    for (const id of ids) {
      if (owner === undefined || owner === 'page') {
        pinned.add(id)

        continue
      }

      owner.direct.add(id)

      for (let unit: Unit | undefined = owner; unit; unit = unit.parent)
        unit.subtree.add(id)
    }
  }

  // `sealed` marks markup inside a block, a component's children or a slot fill: an element there is part of the element holding it, as it renders per item, per branch or per use.
  const walk = (nodes: readonly Node[], scope: Scope, owner: Unit | 'page' | undefined, sealed: boolean): void => {
    const here = new Map(scope)

    for (const node of nodes) {
      const own = binders(node)
      let inner = owner

      if (node.kind === 'element' && !sealed && owner !== 'page' && !node.component && !WHOLE_PAGE.has(node.name) && !isHead(node) && TAG.test(node.name) && node.outlet === undefined && node.fills === undefined && !node.attributes.some(attribute => attribute.kind === 'spread') && !holdsOutlet(node)) {
        inner = { element: node, parent: owner, direct: new Set(), subtree: new Set() }
        units.push(inner)
      }
      else if (isHead(node)) {
        inner = 'page'
      }

      const read = new Set<number>()

      for (const span of nodeExpressions(node)) {
        if (own.includes(span))
          continue

        for (const id of idsOf(readNames(codeOf(text(span))), here))
          read.add(id)
      }

      touch(read, inner)

      if (node.kind === 'const') {
        for (const name of bindingNames(text(node.pattern)))
          here.set(name, read)

        continue
      }

      const childSealed = sealed || node.kind !== 'element' || node.component === true || node.fills !== undefined

      for (const [block, spans] of scopedBlocks(node)) {
        const bound = new Map(here)

        for (const name of spans.flatMap(span => bindingNames(text(span))))
          bound.set(name, read)

        walk(block, bound, inner, childSealed)
      }
    }
  }

  walk(file.template, new Map(), undefined, false)

  const prefix = fileTag(moduleId)
  const groups = new Map<number, { group: number, id: string }>()
  const listed: [number[], number[]][] = []
  const known = new Map<string, number>()

  for (const unit of units) {
    if (unit.subtree.size === 0)
      continue

    const entry: [number[], number[]] = [[...unit.subtree].toSorted((a, b) => a - b), [...unit.direct].toSorted((a, b) => a - b)]
    const key = JSON.stringify(entry)
    let group = known.get(key)

    if (group === undefined) {
      group = listed.push(entry) - 1
      known.set(key, group)
    }

    groups.set(unit.element.start, { group, id: `${prefix}${groups.size}` })
  }

  const names = [...declared].filter(name => server.data.some(data => data.name === name)).map(name => [name, [...new Set(closure(name))]])

  const table = JSON.stringify({
    names,
    needs: needed.map((ids, id) => [...ids].filter(need => need !== id)),
    pinned: [...pinned],
    groups: listed,
  })

  return { table, needs, groups }
}
