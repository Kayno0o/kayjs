import { LOAD_NAME, LOADS_HEADER } from './swap'

// What the compiler writes next to a page's or a layout's loads: the loads (`names`, each name with the ids of the loads whose values it is made of) and, for each element reading loads, the ids its markup reads.
export interface LoadTable {
  names: readonly (readonly [string, readonly number[]])[]
  groups: readonly (readonly number[])[]
}

// What a file's load hands to its markup: whether an element is left to the page as it is, given its group.
export type LoadKept = (group: number) => boolean

const MAX_NAMES = 32

const MAX_HEADER = 2048

// The names a request's refresh asked for, read once; undefined for a request asking for the whole page.
const requested = new WeakMap<Request, ReadonlySet<string> | undefined>()
// The names a request asked for that a load of the chain answers to.
const answered = new WeakMap<Request, Set<string>>()

const none: LoadKept = () => false

// The names in the header of a request, at most `MAX_NAMES` of the form of a binding; anything else is dropped.
export function requestedLoads(request: Request): ReadonlySet<string> | undefined {
  if (requested.has(request))
    return requested.get(request)

  const value = request.headers.get(LOADS_HEADER)
  const names = new Set<string>()

  if (value !== null && value.length <= MAX_HEADER) {
    for (const name of value.split(',')) {
      const trimmed = name.trim()

      if (LOAD_NAME.test(trimmed) && names.size < MAX_NAMES)
        names.add(trimmed)
    }
  }

  const found = names.size === 0 ? undefined : names

  requested.set(request, found)

  return found
}

// Called first in a load: tells which elements stay as they are. Every statement and every load runs either way, so a refusal or an error ends a refresh as it ends the whole page; a request asking for the whole page leaves nothing out.
export function loadScope(request: Request | undefined, table: LoadTable): LoadKept {
  const names = request === undefined ? undefined : requestedLoads(request)

  if (request === undefined || names === undefined)
    return none

  if (!answered.has(request))
    answered.set(request, new Set())

  const asked = new Set<number>()

  for (const [name, ids] of table.names) {
    if (!names.has(name))
      continue

    answered.get(request)?.add(name)

    for (const id of ids)
      asked.add(id)
  }

  return group => !table.groups[group]!.some(id => asked.has(id))
}

// The names a request asked for that no load of the page or its layouts answers to, for development to say so.
export function unansweredLoads(request: Request): string[] {
  const names = requestedLoads(request)
  const found = answered.get(request)

  return names === undefined || found === undefined ? [] : [...names].filter(name => !found.has(name))
}
