import type { ElementNode, KayFile, Node, Span } from './ast'
import type { ServerAnalysis } from './script-server'
import { isHead, nodeExpressions } from './ast'
import { hash } from './host'
import { WORD } from './load-facts'
import { codeOf } from './script'
import { binders, bindingNames, readNames, scopedBlocks } from './template-reads'

// The table the runtime reads (`LoadTable` in `src/runtime/load-scope.ts`), as written into the module.
export interface LoadPlan {
  table: string
  // The group of each element reading loads, by where it starts, with the id the element carries so a refresh finds it again.
  groups: Map<number, { group: number, id: string }>
}

// A tag the browser does not render in the body, or one whose attributes and children belong to the page as a whole.
const WHOLE_PAGE = new Set(['html', 'body', 'head', 'title', 'meta', 'link', 'base', 'style', 'script', 'template', 'noscript', 'slot'])
const TAG = /^[a-z][a-z0-9-]*$/i

interface Unit {
  element: ElementNode
  parent: Unit | undefined
  subtree: Set<number>
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

// The loads of a fence, for a refresh to name: a load is a top-level `const name = await ...` (or a pattern of names), named after the names it declares.
// A refresh runs the whole fence, every statement and every load, as the whole page does, so a refusal or an error ends it the same way; it renders and sends only the elements outside any block of the template that read a load it names, and leaves the others to the page as they are.
export function planLoads(file: KayFile, server: ServerAnalysis, moduleId: string): LoadPlan | undefined {
  const text = (span: Span) => file.source.slice(span.start, span.end)
  const declared = new Set<string>()

  for (const span of server.body) {
    for (const name of server.facts.get(span)?.declared ?? [])
      declared.add(name)
  }

  // What each name of the fence depends on: the loads that make it, and the names whose values it is made of.
  const base = new Map<string, number[]>()
  const edges = new Map<string, Set<string>>()
  let count = 0

  const link = (name: string, words: readonly string[]) => {
    const set = edges.get(name) ?? new Set<string>()

    for (const word of words) {
      if (declared.has(word) && word !== name)
        set.add(word)
    }

    edges.set(name, set)
  }

  const statements: { words: string[], declares: boolean }[] = []

  for (const span of server.body) {
    const fact = server.facts.get(span)

    if (fact === undefined)
      continue

    if (fact.awaits && fact.declared.length > 0) {
      const id = count++

      for (const name of fact.declared)
        base.set(name, [id])
    }

    for (const name of fact.declared)
      link(name, fact.words)

    statements.push({ words: fact.words, declares: fact.declared.length > 0 })
  }

  if (count === 0)
    return undefined

  const closure = (name: string, seen = new Set<string>()): number[] => {
    if (seen.has(name))
      return []

    seen.add(name)

    return [...base.get(name) ?? [], ...[...edges.get(name) ?? []].flatMap(next => closure(next, seen))]
  }

  const reach = (name: string, seen = new Set<string>()): Set<string> => {
    seen.add(name)

    for (const next of edges.get(name) ?? []) {
      if (!seen.has(next))
        reach(next, seen)
    }

    return seen
  }

  // A statement that declares nothing may change any value it mentions, or a value one of them is made of (an alias): they now depend on each other.
  for (const { words, declares } of statements) {
    if (declares)
      continue

    const group = new Set([...new Set(words)].filter(word => declared.has(word)).flatMap(word => [...reach(word)]))

    for (const name of group)
      link(name, [...group])
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
    if (owner === undefined || owner === 'page')
      return

    for (let unit: Unit | undefined = owner; unit; unit = unit.parent) {
      for (const id of ids)
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
        inner = { element: node, parent: owner, subtree: new Set() }
        units.push(inner)
      }
      else if (isHead(node)) {
        inner = 'page'
      }

      const read = new Set<number>()

      for (const span of nodeExpressions(node)) {
        if (own.includes(span)) {
          // A default in a pattern reads names too.
          for (const id of idsOf(text(span).match(WORD) ?? [], here))
            read.add(id)

          continue
        }

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

  const prefix = hash(moduleId).slice(-6)
  const groups = new Map<number, { group: number, id: string }>()
  const listed: number[][] = []
  const known = new Map<string, number>()

  for (const unit of units) {
    if (unit.subtree.size === 0)
      continue

    const ids = [...unit.subtree].toSorted((a, b) => a - b)
    const key = ids.join(',')
    let group = known.get(key)

    if (group === undefined) {
      group = listed.push(ids) - 1
      known.set(key, group)
    }

    groups.set(unit.element.start, { group, id: `${prefix}-${groups.size}` })
  }

  const names = [...declared].filter(name => server.data.some(data => data.name === name)).map(name => [name, [...new Set(closure(name))]])

  return { table: JSON.stringify({ names, groups: listed }), groups }
}
