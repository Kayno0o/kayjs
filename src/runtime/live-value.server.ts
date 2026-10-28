import type { Entries, Handle, LiveKey, LiveStore } from './live-value.shared'
import type { ServerScope } from './reactive'
import { initialOf, keyText } from './live-value.shared'
import { kayLog } from './log'
import { currentServerScope } from './reactive'
import { decodeServerValue, encodeValue } from './wire'

// The server's half of `live()`: the values by id, their expiry, the store sharing them across processes and what a render read of them.

// Another copy of this module, such as a workspace's second install or a dev reload, shares the one registry.
const REGISTRY = Symbol.for('kay.live')

interface ServerSlot {
  id: string
  // The constant it is declared as, which only the server knows: what its errors call it by.
  name: string | undefined
  initial: unknown
  keyed: boolean
  // A value of each user, stored under the user's id and read with no key: a page proves it bound to the user it was rendered for.
  own: boolean
  values: Map<string, unknown>
  listeners: Map<string, Set<() => void>>
  // The lifetime of a value in milliseconds after its last write, from the declaration's `ttl`.
  ttl: number | undefined
  // When each value held with an end is forgotten, in milliseconds; a read past it gives what the declaration gives, and the timer drops it and tells the watchers.
  expires: Map<string, number>
  // Whether `expires` is ordered by end, as local writes keep it, so the timer reads only its first keys; an end heard out of order clears it until the next pass sorts the map. `latest` is an upper bound of the ends held.
  ordered: boolean
  latest: number
  timer: { handle: ReturnType<typeof setTimeout>, at: number } | undefined
}

function slots(): Map<string, ServerSlot> {
  const holder = globalThis as Record<symbol, Map<string, ServerSlot> | undefined>

  return holder[REGISTRY] ??= new Map<string, ServerSlot>()
}

// The server's slot of a value, by id; the connection reads and watches values through it.
export function liveSlot(id: string): ServerSlot | undefined {
  return slots().get(id)
}

// The current value of a slot's key.
export function slotValue(slot: ServerSlot, key: string): unknown {
  return slot.values.has(key) && !expired(slot, key) ? slot.values.get(key) : initialOf(slot, key)
}

function expired(slot: ServerSlot, key: string): boolean {
  const at = slot.expires.get(key)

  return at !== undefined && at <= Date.now()
}

// The longest a timer waits in one go, as the platform caps it near 24.8 days: a longer lifetime waits again when it fires.
const MAX_TIMER_MS = 2_000_000_000
// The shortest, so a crowd of values ending a few milliseconds apart is dropped in few passes.
const MIN_TIMER_MS = 25

// Sets or clears when a key is forgotten, and makes sure a timer is due by then.
function setExpiry(slot: ServerSlot, key: string, at: number | undefined): void {
  // Deleted first, so the key moves to the end of the map.
  slot.expires.delete(key)

  if (at === undefined)
    return

  if (slot.expires.size === 0 || at >= slot.latest)
    slot.latest = at
  else
    slot.ordered = false

  slot.expires.set(key, at)

  if (slot.timer !== undefined && at < slot.timer.at) {
    // The timer was due at the lowest end, so this one is the new lowest.
    clearTimeout(slot.timer.handle)
    slot.timer = undefined
    armExpiry(slot, at)

    return
  }

  armExpiry(slot)
}

// Puts `expires` in order of end again, once an end was heard out of order.
function sortExpiry(slot: ServerSlot): void {
  if (slot.ordered)
    return

  slot.expires = new Map([...slot.expires].sort((first, second) => first[1] - second[1]))
  slot.ordered = true
  slot.latest = [...slot.expires.values()].at(-1) ?? 0
}

function armExpiry(slot: ServerSlot, lowest?: number): void {
  if (slot.timer !== undefined || slot.expires.size === 0)
    return

  sortExpiry(slot)

  const next = lowest ?? slot.expires.values().next().value!
  const handle = setTimeout(() => {
    slot.timer = undefined
    dropExpired(slot)
  }, Math.min(Math.max(next - Date.now(), MIN_TIMER_MS), MAX_TIMER_MS))

  // A timer must not keep a process alive.
  ;(handle as { unref?: () => void }).unref?.()
  slot.timer = { handle, at: next }
}

// Forgets the values past their end, only in this process: the store drops its own row, and each process ends the value itself.
function dropExpired(slot: ServerSlot): void {
  const now = Date.now()

  sortExpiry(slot)

  const gone: string[] = []

  for (const [key, at] of slot.expires) {
    // In order of end, so the first one still to come ends the pass.
    if (at > now)
      break

    gone.push(key)
  }

  for (const key of gone)
    slot.expires.delete(key)

  armExpiry(slot)

  // After the map is settled, as a watcher may write a value of the slot.
  for (const key of gone) {
    // A watcher told of an earlier key may have written this one again.
    if (!slot.expires.has(key) && slot.values.delete(key))
      notify(slot, key)
  }
}

// Calls `listener` whenever the key changes; gives what stops it.
export function watchSlot(slot: ServerSlot, key: string, listener: () => void): () => void {
  let set = slot.listeners.get(key)

  if (!set)
    slot.listeners.set(key, set = new Set())

  set.add(listener)
  // The watchers of the app's values keep a store that slows its poll at its pace, as they wait on the next change.
  const kept = state()
  const counted = shared(slot)

  if (counted && ++kept.watchers === 1)
    kept.store?.hold?.(true)

  let watching = true

  return () => {
    if (watching && counted && --kept.watchers === 0)
      kept.store?.hold?.(false)

    watching = false
    set.delete(listener)

    if (set.size === 0 && slot.listeners.get(key) === set)
      slot.listeners.delete(key)
  }
}

// What the server keeps beside the slots, shared as they are: a second copy of this module sets and hears through the same store.
interface ServerState {
  store: LiveStore | undefined
  subscribed: WeakSet<LiveStore>
  // What the store holds for a value no module declared yet, by id then key: taken when its declaration runs.
  undeclared: Map<string, Map<string, string>>
  // The rows of `undeclared` that count toward the cap: the ones heard after the start. What the store held at the start is bounded by the store and never dropped.
  undeclaredRows: number
  // When the rows of `undeclared` end, by id and key as `writtenKey` joins them.
  undeclaredExpiry: Map<string, number>
  // The ids with rows read at the start.
  startup: Set<string>
  checkWrite: ((label: string, value: unknown) => void) | undefined
  // The keys set or deleted here while the store is still being read, which an older stored row must not overwrite.
  written: Set<string> | undefined
  // The ids whose rows read in this pass without an end are dated by one write of the store, sent once the pass ends.
  dating: Set<string>
  // The read of a store that answers late.
  reading: Promise<void> | undefined
  // The store read at the start and not followed yet, as no module declared a value of the app.
  idle: LiveStore | undefined
  // The watchers of the app's values, held by connections.
  watchers: number
  viewer: (() => string | undefined) | undefined
}

const STATE = Symbol.for('kay.live.state')
// The most rows kept for values no module declared: the id heard from longest ago goes beyond it, as a value nobody declares is not one this process shows.
const UNDECLARED_ROWS = 10_000

function state(): ServerState {
  const holder = globalThis as Record<symbol, ServerState | undefined>

  return holder[STATE] ??= { store: undefined, subscribed: new WeakSet(), undeclared: new Map(), undeclaredRows: 0, undeclaredExpiry: new Map(), startup: new Set(), checkWrite: undefined, written: undefined, dating: new Set(), reading: undefined, idle: undefined, watchers: 0, viewer: undefined }
}

// Installed by the server: refuses a value a browser could not be sent where it is set.
export function checkLiveWrites(check: (label: string, value: unknown) => void): void {
  state().checkWrite = check
}

function notify(slot: ServerSlot, key: string): void {
  for (const listener of slot.listeners.get(key) ?? [])
    listener()
}

const slotOfHandle = new WeakMap<object, ServerSlot>()

// Whether any value of each user is declared, which a streamed page's render cannot wait to find out.
export function ownLiveDeclared(): boolean {
  for (const slot of slots().values()) {
    if (slot.own)
      return true
  }

  return false
}

// The signed-in user of the render in progress, which the server resolves for a render that reads a value of each user; installed by the server.
export function readViewerWith(viewer: () => string | undefined): void {
  state().viewer = viewer
}

// The value of the user the render is for, noted for the page's proof with that user bound to it; what the declaration gives when nobody is signed in, which no page follows.
function readOwn(slot: ServerSlot): unknown {
  const user = state().viewer?.()

  if (user === undefined)
    return slot.initial

  const value = slotValue(slot, user)

  noteRead(slot, '', value, true)

  return value
}

// An island's server render notes the live values it imports, so the page proves them though the render did not read them, as when a handler or a `--- client` fence reads one later. A keyed value is left out: its key is not known before it is read.
export function noteLives(handles: readonly unknown[]): void {
  for (const handle of handles) {
    const slot = typeof handle === 'function' ? slotOfHandle.get(handle) : undefined

    if (slot?.own)
      readOwn(slot)
    else if (slot !== undefined && !slot.keyed)
      noteRead(slot, '', slotValue(slot, ''))
  }
}

// The ids kay keeps for itself (cached values followed by pages, presence) are not the app's values and stay in memory.
const OWN_ID = /^kay:/

function shared(slot: ServerSlot): boolean {
  return state().store !== undefined && !OWN_ID.test(slot.id)
}

// Keeps what the store holds for an id no module declared yet, or forgets it for a deleted key.
function keepUndeclared(id: string, key: string, text: string | undefined, atStart: boolean, expiresAt?: number): void {
  const kept = state()
  let held = kept.undeclared.get(id)

  // An id with rows heard before joins the set that is never dropped: they stop counting.
  if (atStart && !kept.startup.has(id)) {
    kept.undeclaredRows -= held?.size ?? 0
    kept.startup.add(id)
  }

  const counted = !kept.startup.has(id)

  if (text === undefined || expiresAt === undefined)
    kept.undeclaredExpiry.delete(writtenKey(id, key))
  else
    kept.undeclaredExpiry.set(writtenKey(id, key), expiresAt)

  if (text === undefined) {
    if (held?.delete(key) && counted)
      kept.undeclaredRows--

    return
  }

  // Reinserted last, so the id dropped first is the one heard from longest ago.
  if (held === undefined || counted) {
    kept.undeclared.delete(id)
    kept.undeclared.set(id, held ??= new Map<string, string>())
  }

  if (!held.has(key) && counted)
    kept.undeclaredRows++

  held.set(key, text)

  while (kept.undeclaredRows > UNDECLARED_ROWS) {
    const dropped = [...kept.undeclared].find(([other]) => !kept.startup.has(other))

    if (dropped === undefined)
      break

    kayLog('warn', `the live value ${dropped[0]} was set by another process and no module here declares it: its ${dropped[1].size} stored rows are dropped`)
    kept.undeclared.delete(dropped[0])

    for (const droppedKey of dropped[1].keys())
      kept.undeclaredExpiry.delete(writtenKey(dropped[0], droppedKey))

    kept.undeclaredRows -= dropped[1].size
  }
}

// Called by the setup of a server with the config's `store.live`: reads what it holds, then follows what the other processes set. A store that reads over a network is waited for with `liveStoreReady`.
export function setLiveStore(store: LiveStore | undefined): void {
  const kept = state()

  if (store === kept.store)
    return

  const replaced = kept.store

  kept.store = store
  kept.idle = undefined

  if (replaced !== undefined) {
    replaced.stop?.()
    kept.subscribed.delete(replaced)
  }

  if (store === undefined)
    return

  const held = store.entries()

  if (!Array.isArray(held)) {
    kept.reading = readLater(store, held)

    return
  }

  for (const [id, key, text, expiresAt] of held)
    hear(id, key, text, true, expiresAt)

  follow(store)
}

// Resolves once the store last given to `setLiveStore` was read, at once for one that answers synchronously.
export async function liveStoreReady(): Promise<void> {
  await state().reading
}

// Reads a store that answers late: a value set here meanwhile is newer than its rows.
async function readLater(store: LiveStore, pending: Promise<Entries>): Promise<void> {
  const kept = state()
  const written = new Set<string>()

  kept.written = written

  try {
    const held = await pending

    if (kept.store !== store)
      return

    for (const [id, key, text, expiresAt] of held) {
      if (!written.has(writtenKey(id, key)))
        hear(id, key, text, true, expiresAt)
    }
  }
  finally {
    if (kept.written === written)
      kept.written = undefined
  }

  if (kept.store === store)
    follow(store)
}

// A store with no value of the app declared has nothing to follow: the first declaration reads it again and follows, so the store is not polled until then.
function follow(store: LiveStore): void {
  const kept = state()

  if (kept.subscribed.has(store))
    return

  if (![...slots().values()].some(shared)) {
    kept.idle = store

    return
  }

  kept.subscribed.add(store)
  // A store replaced or removed since still delivers, which is ignored.
  store.subscribe((id, key, text, expiresAt) => {
    if (kept.store === store)
      hear(id, key, text, false, expiresAt)
  })

  if (kept.watchers > 0)
    store.hold?.(true)
}

// Reads a store again that was left unfollowed, then follows it: what the other processes set meanwhile is in its rows, and `entries` notes the last event before reading them so none is missed.
function followLate(store: LiveStore): void {
  const kept = state()

  kept.idle = undefined

  const rows = store.entries()

  if (!Array.isArray(rows)) {
    kept.reading = readLater(store, rows)

    return
  }

  for (const [id, key, text, expiresAt] of rows)
    hear(id, key, text, true, expiresAt)

  follow(store)
}

function writtenKey(id: string, key: string): string {
  return `${id}\0${key}`
}

// Hands a change to the store: a synchronous store may throw to refuse it, and a promise runs behind with its failure logged.
function sendToStore(id: string, key: string, change: (store: LiveStore) => void | Promise<void>): void {
  const kept = state()

  kept.written?.add(writtenKey(id, key))

  const sent = change(kept.store!)

  if (sent !== undefined)
    void logged(sent, id)
}

async function logged(sent: Promise<void>, id: string): Promise<void> {
  try {
    await sent
  }
  catch (error) {
    kayLog('error', `the live value ${id} could not be written to the store`, error)
  }
}

function decoded(text: string, id: string): { value: unknown } | undefined {
  try {
    return { value: decodeServerValue(text) }
  }
  catch (error) {
    kayLog('error', `the live value ${id} held in the store could not be read; it is left out`, error)

    return undefined
  }
}

// A value the store holds, set here without telling the store: the watchers of a slot see it as any change.
function hear(id: string, key: string, text: string | undefined, atStart = false, expiresAt?: number): void {
  const slot = slots().get(id)

  // A row past its end is a key deleted.
  const gone = text === undefined || (expiresAt !== undefined && expiresAt <= Date.now())

  if (slot === undefined) {
    keepUndeclared(id, key, gone ? undefined : text, atStart, expiresAt)

    return
  }

  if (gone) {
    slot.expires.delete(key)

    if (slot.values.delete(key))
      notify(slot, key)

    return
  }

  const read = decoded(text, id)

  if (read === undefined)
    return

  setExpiry(slot, key, expiresAt ?? (atStart ? stamped(slot, key, text) : undefined))

  if (slot.values.has(key) && encodeValue(slot.values.get(key)) === text)
    return

  slot.values.set(key, read.value)
  notify(slot, key)
}

// The end of a value the store holds without one, though its declaration has a `ttl` now (it was stored before): the lifetime counts from the first time this process reads it, and the store keeps that end so a restart does not renew it. Only rows read at the start, or heard before their declaration, are given one, so a store that ignores the end cannot make processes rewrite a row at each other. The store only sets the end where none is, so a value another replica sets meanwhile is kept.
function stamped(slot: ServerSlot, key: string, text: string): number | undefined {
  if (slot.ttl === undefined)
    return undefined

  const expiresAt = Date.now() + slot.ttl

  if (shared(slot)) {
    if (state().store?.endAll !== undefined) {
      datedTogether(slot.id)
    }
    else {
      try {
        sendToStore(slot.id, key, (store): void | Promise<void> => store.end === undefined ? store.set(slot.id, key, text, expiresAt) : store.end(slot.id, key, expiresAt))
      }
      catch (error) {
        // A store may refuse a write; the end stays local, and the next start tries again.
        kayLog('error', `the end of the live value ${slot.id} could not be written to the store`, error)
      }
    }
  }

  return expiresAt
}

// Dates all the rows of an id with one statement of the store, once the rows being read are all heard: the rows are many, and a write for each would queue one transaction and one event apiece.
function datedTogether(id: string): void {
  const kept = state()

  if (kept.dating.size === 0) {
    queueMicrotask(() => {
      const ids = [...kept.dating]
      const store = kept.store

      kept.dating.clear()

      for (const dated of ids) {
        const ttl = slots().get(dated)?.ttl

        if (ttl === undefined || store?.endAll === undefined)
          continue

        try {
          const sent = store.endAll(dated, ttl)

          if (sent !== undefined)
            void logged(sent, dated)
        }
        catch (error) {
          kayLog('error', `the end of the live value ${dated} could not be written to the store`, error)
        }
      }
    })
  }

  kept.dating.add(id)
}

export function serverLive(id: string, initial: unknown, name: string | undefined, ttl: number | undefined, own: boolean): Handle {
  if (own && typeof initial === 'function')
    throw new TypeError(`kay: live(${id}) with \`user: true\` is one value for each user, so its starting value is not a function of a key`)

  const keyed = typeof initial === 'function' && !own
  const known = slots().get(id)
  // A dev reload evaluates the module again: the values and watchers stay, the declaration is the new one.
  const slot: ServerSlot = known ?? { id, name, initial, keyed, own, values: new Map(), listeners: new Map(), ttl, expires: new Map(), ordered: true, latest: 0, timer: undefined }

  if (known) {
    known.initial = initial
    known.keyed = keyed
    known.own = own
    known.name = name
    known.ttl = ttl
  }

  slots().set(id, slot)

  if (!known) {
    const kept = state()
    // The rows read at the start are older than the store: a late follow reads them again, so none of them is used and a key another process deleted since does not stay.
    const idle = kept.idle !== undefined && kept.idle === kept.store && shared(slot) ? kept.idle : undefined

    if (idle !== undefined) {
      kept.undeclared.clear()
      kept.undeclaredExpiry.clear()
      kept.startup.clear()
      kept.undeclaredRows = 0
    }

    const held = kept.undeclared.get(id)

    for (const [key, text] of held ?? []) {
      const at = kept.undeclaredExpiry.get(writtenKey(id, key))

      kept.undeclaredExpiry.delete(writtenKey(id, key))

      if (at !== undefined && at <= Date.now())
        continue

      const read = decoded(text, id)

      if (read !== undefined) {
        slot.values.set(key, read.value)
        setExpiry(slot, key, at ?? stamped(slot, key, text))
      }
    }

    if (held !== undefined) {
      kept.undeclared.delete(id)

      if (!kept.startup.delete(id))
        kept.undeclaredRows -= held.size
    }

    if (idle !== undefined)
      followLate(idle)
  }

  const read = (key: string): unknown => {
    const value = slotValue(slot, key)

    noteRead(slot, key, value)

    return value
  }

  const write = (key: string, next: unknown): void => {
    const current = slotValue(slot, key)
    const value = typeof next === 'function' ? (next as (current: unknown) => unknown)(current) : next

    const same = Object.is(value, current)

    // This process's copy can be up to half a second behind the store, so a value equal to it is skipped even when another process has set a newer one since. With a `ttl` it is written again, to renew it.
    if (same && slot.ttl === undefined)
      return

    if (!same)
      state().checkWrite?.(slot.name === undefined ? slot.id : `${slot.name} (${slot.id})`, value)

    const expiresAt = slot.ttl === undefined ? undefined : Date.now() + slot.ttl
    // A value past its end that no timer dropped yet is still shown to the watchers.
    const shown = !same || expired(slot, key)

    // The store first, so a refusal leaves the value as it was.
    if (shared(slot))
      sendToStore(slot.id, key, (store): void | Promise<void> => store.set(slot.id, key, encodeValue(value), expiresAt))

    slot.values.set(key, value)
    setExpiry(slot, key, expiresAt)

    if (shown)
      notify(slot, key)
  }

  const readOne = own ? () => readOwn(slot) : () => read('')
  const handle = keyed ? (key: LiveKey) => read(keyText(key)) : readOne

  slotOfHandle.set(handle, slot)

  const remove = (key: LiveKey) => {
    if (!slot.values.has(keyText(key)))
      return

    if (shared(slot))
      sendToStore(slot.id, keyText(key), (store): void | Promise<void> => store.delete(slot.id, keyText(key)))

    slot.values.delete(keyText(key))
    slot.expires.delete(keyText(key))
    notify(slot, keyText(key))
  }

  return Object.assign(handle, keyed || own
    ? {
      set: (key: LiveKey, next: unknown) => write(keyText(key), next),
      delete: remove,
    }
    : { set: (next: unknown) => write('', next) }) as unknown as Handle
}

// A render of a page lists what it read, for its script and the proof of it.
function noteRead(slot: ServerSlot, key: string, value: unknown, own = false): void {
  const scope: ServerScope | undefined = currentServerScope()

  if (scope === undefined)
    return

  const reads = scope.live ??= new Map()
  const at = `${slot.id}\0${key}`

  if (!reads.has(at))
    reads.set(at, { id: slot.id, key, value, ...own && { own: true as const } })
}
