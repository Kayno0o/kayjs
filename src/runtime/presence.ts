import { NON_ROOT_TRAILING_SLASH, withoutBase } from './base'
import { lasting } from './lasting'
import { hold, live, wanted } from './live-value'
import { randomId } from './random-id'
import { currentServerScope, onCleanup, ownSignal } from './reactive'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// The id the members of a room are known by on the live connection: one keyed value, whose key is the room with the member the visitor is listed as, and whose value is the members of the room besides the visitor's own tab, as JSON.
export const PRESENCE_LIVE_ID = 'kay:presence'
// A key is at most this long, as any live key is.
const MAX_PRESENCE_KEY = 256

// Who else has a room open. Called, it stops listening: `others()` and `count()` read nothing more, so the page leaves the room as no other read of it holds it.
export interface Presence<Member> {
  (): void
  // The distinct members other than the visitor's own, so their other tabs are left out, in the order they joined.
  others: () => Member[]
  // How many other tabs have the room open, the visitor's own other tabs included.
  count: () => number
}

type Handle = (key: string) => string[]

let handle: Handle | undefined
let readMembers: Handle | undefined

// Installed by the server: the members a room holds now, for the render to write into the page.
export function readPresenceWith(read: (key: string) => string[]): void {
  readMembers = read
}

// The path of the page under `base` without its trailing slash, which the server renders for and the browser is at.
function pagePath(): string {
  const path = typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? currentServerScope()?.path : withoutBase(location.pathname)

  if (path === undefined)
    throw new TypeError('kay: presence() with no room is the page\'s own, which only a render or a browser knows; name a room, or call it in an island')

  return path.replace(NON_ROOT_TRAILING_SLASH, '')
}

export interface PresenceOptions {
  // Stops listening when aborted, as calling the result does.
  signal?: AbortSignal | undefined
}

// Opens the connection's tab for a presence key, and names this tab to the server.
function holdConnection(): void {
  hold.open ??= () => [...wanted.keys()].some(key => key.startsWith(`["${PRESENCE_LIVE_ID}",`))
  hold.tab ??= randomId(12)
}

// Who else has a room open, in an island: `presence(`entry:${id}`, { name })` lists the others' members, `presence()` counts the tabs on the page.
// The page proves the room and the member as it does any live read, so what a visitor is listed as comes from the server fence that passed it, and the page is rendered per request.
// A member is any value that crosses as island props do, compared as JSON; a room and its member take at most 256 characters as JSON.
// kept: request
export function presence(options?: PresenceOptions): Presence<null>
export function presence<Member = null>(room: string, member?: Member, options?: PresenceOptions): Presence<Member>
export function presence(first?: string | PresenceOptions, member?: unknown, extra?: PresenceOptions): Presence<unknown> {
  const room = typeof first === 'string' ? first : undefined
  const options = typeof first === 'object' ? first : extra
  const key = JSON.stringify([room ?? pagePath(), member ?? null])

  if (key.length > MAX_PRESENCE_KEY)
    throw new RangeError(`kay: presence(${key.slice(0, 40)}...): a room and its member are at most ${MAX_PRESENCE_KEY} characters as JSON`)

  handle ??= (live as (initial: Handle, id: string, name: string) => Handle)((name: string) => readMembers?.(name) ?? [], PRESENCE_LIVE_ID, 'presence')

  const members = handle
  const left = options?.signal?.aborted === true
  const [stopped, stop] = ownSignal(left)
  const own = JSON.stringify(member ?? null)

  if (left) {
    // Starts nothing: the page neither proves the room nor holds a connection for it.
  }
  else if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined') {
    members(key) // read now, so the render notes the key the page proves
  }
  else {
    holdConnection()
  }

  const read = (): string[] => stopped() ? [] : members(key)
  const end = lasting('presence', presence, () => onCleanup(() => stop(true)), options?.signal)

  return Object.assign(end, {
    others: () => [...new Set(read().filter(text => text !== own))].map(text => JSON.parse(text) as unknown),
    count: () => read().length,
  })
}
