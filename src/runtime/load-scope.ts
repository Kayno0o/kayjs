import { currentServerScope } from './reactive'
import { LOADS_HEADER } from './swap'

// What the compiler writes next to a page's or a layout's loads: the loads (`names`, each name with the ids of the loads it stands for), what each load reads of another (`needs`), the loads read outside any element (`pinned`), and each element reading loads as the ids its whole markup reads and the ids its own attributes and text read.
export interface LoadTable {
  names: readonly (readonly [string, readonly number[]])[]
  needs: readonly (readonly number[])[]
  pinned: readonly number[]
  groups: readonly (readonly [subtree: readonly number[], direct: readonly number[]])[]
}

const MAX_NAMES = 32
const NAME = /^[\w$]{1,64}$/
const MAX_HEADER = 2048

// The names a request's refresh asked for, read once; undefined for a request asking for the whole page.
const requested = new WeakMap<Request, ReadonlySet<string> | undefined>()
// The loads each file ran for a request, which its markup reads to tell what it keeps.
const scopes = new WeakMap<Request, WeakMap<LoadTable, ReadonlySet<number>>>()
// The names a request asked for that a load of the chain answers to.
const answered = new WeakMap<Request, Set<string>>()
// Set once any request asked for loads, so a server that never receives one reads nothing per element.
let used = false

// The names in the header of a request, at most `MAX_NAMES` of the form of a binding; anything else is dropped.
export function requestedLoads(request: Request): ReadonlySet<string> | undefined {
  if (requested.has(request))
    return requested.get(request)

  const value = request.headers.get(LOADS_HEADER)
  const names = new Set<string>()

  if (value !== null && value.length <= MAX_HEADER) {
    for (const name of value.split(',')) {
      const trimmed = name.trim()

      if (NAME.test(trimmed) && names.size < MAX_NAMES)
        names.add(trimmed)
    }
  }

  const found = names.size === 0 ? undefined : names

  requested.set(request, found)

  return found
}

// The ids of the loads to run for the names asked: those, the loads they read, those read outside any element, and the loads read by the attributes and text of an element showing any of them.
function running(table: LoadTable, names: ReadonlySet<string>, request: Request): Set<number> {
  const runs = new Set<number>(table.pinned)

  for (const [name, ids] of table.names) {
    if (!names.has(name))
      continue

    answered.get(request)?.add(name)

    for (const id of ids)
      runs.add(id)
  }

  const close = () => {
    let grew = false

    for (const id of runs) {
      for (const need of table.needs[id] ?? []) {
        if (!runs.has(need)) {
          runs.add(need)
          grew = true
        }
      }
    }

    return grew
  }

  for (let more = true; more;) {
    more = close()

    for (const [subtree, direct] of table.groups) {
      if (!subtree.some(id => runs.has(id)))
        continue

      for (const id of direct) {
        if (!runs.has(id)) {
          runs.add(id)
          more = true
        }
      }
    }
  }

  return runs
}

// Called first in a load: tells whether a statement runs, given the ids of the loads it needs. A request asking for the whole page runs every one.
export function loadScope(request: Request | undefined, table: LoadTable): (...ids: number[]) => boolean {
  const names = request === undefined ? undefined : requestedLoads(request)

  if (request === undefined || names === undefined)
    return () => true

  used = true

  if (!answered.has(request))
    answered.set(request, new Set())

  const runs = running(table, names, request)
  const forRequest = scopes.get(request) ?? new WeakMap<LoadTable, ReadonlySet<number>>()

  forRequest.set(table, runs)
  scopes.set(request, forRequest)

  return (...ids) => ids.every(id => runs.has(id))
}

// Whether the element reading the loads of `group` is left to the page as it is: it shows none of the loads this request runs.
export function kept(table: LoadTable, group: number): boolean {
  if (!used)
    return false

  const request = currentServerScope()?.request
  const runs = request === undefined ? undefined : scopes.get(request)?.get(table)

  return runs !== undefined && !table.groups[group]![0].some(id => runs.has(id))
}

// The names a request asked for that no load of the page or its layouts answers to, for development to say so.
export function unansweredLoads(request: Request): string[] {
  const names = requestedLoads(request)
  const found = answered.get(request)

  return names === undefined || found === undefined ? [] : [...names].filter(name => !found.has(name))
}
