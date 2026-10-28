import type { Duration } from './duration'
import type { Live, LiveByKey, LiveKey, LiveOptions, LiveOwn } from './live-value.shared'
import type { PlainValue } from './reactive'
import { durationSeconds } from './duration'
import { browserLive } from './live-value.client'
import { serverLive } from './live-value.server'

export { hold, wanted } from './live-value.client'
export { checkLiveWrites, liveSlot, liveStoreReady, noteLives, ownLiveDeclared, readViewerWith, setLiveStore, slotValue, watchSlot } from './live-value.server'
export type { Live, LiveByKey, LiveEntry, LiveKey, LiveOptions, LiveOwn, LivePage, LiveRequest, LiveStore, LiveUpdate } from './live-value.shared'
export { LIVE_ROUTE, LIVE_SCRIPT, PROOF_LIFETIME_MS } from './live-value.shared'

// Defined by the browser build, which never runs the server's half: tested where it is read, so the bundler drops it.
declare const KAY_BROWSER: true | undefined

// A value the server changes and every page showing it follows: `export const visitors = live(0)` in a module, read in a template as `{visitors()}`, written on the server with `visitors.set(n => n + 1)`.
// Given a function of a key it is one value per key, `export const room = live((id: string) => ({ users: 0 }))`, read as `room(id)` and written as `room.set(id, ...)`.
// The build gives each declaration its id, so it is written as `export const name = live(...)` at the top of a module.
// `live(0, { ttl: '7d' })` forgets the value, in every store, that long after its last write.
// `live(0, { user: true })` is one value for each signed-in user, sent only to that user's own pages: `unread()` reads the visitor's, `unread.set(userId, 3)` writes one user's.
export function live<T, const Ttl extends Duration = Duration>(initial: PlainValue<T>, options: LiveOptions<Ttl> & { user: true }): LiveOwn<T>
export function live<T, const Ttl extends Duration = Duration>(initial: PlainValue<T>, options?: LiveOptions<Ttl>): Live<T>
export function live<K extends LiveKey, T, const Ttl extends Duration = Duration>(initial: (key: K) => PlainValue<T>, options?: LiveOptions<Ttl>): LiveByKey<K, T>
// The build adds the id and the name after the value, before the options when there are some, so a browser reads the id second without looking for the options it has no use for.
export function live(initial: unknown, id?: unknown, name?: unknown, options?: unknown): unknown {
  if (typeof id !== 'string')
    throw new TypeError('kay: live() is declared as `export const name = live(...)` at the top of a module in the project, where the build names it')

  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? serverLive(id, initial, typeof name === 'string' ? name : undefined, ttlOf(id, name, options), declaredOptions(name, options)?.user === true) : browserLive(id, initial)
}

// The options of a declaration, which follow the id, or the name when there is one.
function declaredOptions(name: unknown, options: unknown): LiveOptions | null | undefined {
  return (typeof name === 'object' ? name : options) as LiveOptions | null | undefined
}

// The lifetime in milliseconds a declaration gives its value, from the options that follow the id, or the name when there is one.
function ttlOf(id: string, name: unknown, options: unknown): number | undefined {
  const declared = declaredOptions(name, options)

  return declared?.ttl === undefined ? undefined : durationSeconds(declared.ttl, `the ttl of live() ${typeof name === 'string' ? name : id}`) * 1000
}
