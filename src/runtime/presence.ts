import { NON_ROOT_TRAILING_SLASH, withoutBase } from './base'
import { hold, live, wanted } from './live-value'
import { currentServerScope } from './reactive'

// The id the members of a room are known by on the live connection: one keyed value, whose key is the room with the member the visitor is listed as, and whose value is the members of the room besides the visitor's own tab, as JSON.
export const PRESENCE_LIVE_ID = 'kay:presence'
// A key is at most this long, as any live key is.
export const MAX_PRESENCE_KEY = 256

// Who else has a room open.
export interface Presence<Member> {
  // The distinct members other than the visitor's own, so their other tabs are left out, in the order they joined.
  others: () => Member[]
  // How many other tabs have the room open, the visitor's own other tabs included.
  count: () => number
}

type Handle = (key: string) => string[]

let handle: Handle | undefined
let readMembers: ((key: string) => string[]) | undefined

// Installed by the server: the members a room holds now, for the render to write into the page.
export function readPresenceWith(read: (key: string) => string[]): void {
  readMembers = read
}

// The path of the page under `base` without its trailing slash, which the server renders for and the browser is at.
function pagePath(): string {
  const path = typeof document === 'undefined' ? currentServerScope()?.path : withoutBase(location.pathname)

  if (path === undefined)
    throw new TypeError('kay: presence() with no room is the page\'s own, which only a render or a browser knows; name a room, or call it in an island')

  return path.replace(NON_ROOT_TRAILING_SLASH, '')
}

// Opens the connection's tab for a presence key, and names this tab to the server.
function holdConnection(): void {
  hold.open ??= () => [...wanted.keys()].some(key => key.startsWith(`["${PRESENCE_LIVE_ID}",`))
  hold.tab ??= Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
}

// Who else has a room open, in an island: `presence(`entry:${id}`, { name })` lists the others' members, `presence()` counts the tabs on the page.
// The page proves the room and the member as it does any live read, so what a visitor is listed as comes from the server fence that passed it, and the page is rendered per request.
// A member is any value that crosses as island props do, compared as JSON; a room and its member take at most 256 characters as JSON.
export function presence(): Presence<null>
export function presence<Member = null>(room: string, member?: Member): Presence<Member>
export function presence(room?: string, member?: unknown): Presence<unknown> {
  const key = JSON.stringify([room ?? pagePath(), member ?? null])

  if (key.length > MAX_PRESENCE_KEY)
    throw new RangeError(`kay: presence(${key.slice(0, 40)}...): a room and its member are at most ${MAX_PRESENCE_KEY} characters as JSON`)

  handle ??= (live as (initial: Handle, id: string, name: string) => Handle)((name: string) => readMembers?.(name) ?? [], PRESENCE_LIVE_ID, 'presence')

  const members = handle
  const own = JSON.stringify(member ?? null)

  if (typeof document === 'undefined')
    members(key) // read now, so the render notes the key the page proves
  else
    holdConnection()

  return {
    others: () => [...new Set(members(key).filter(text => text !== own))].map(text => JSON.parse(text) as unknown),
    count: () => members(key).length,
  }
}
