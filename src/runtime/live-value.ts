import type { Setter } from './index'
import type { ServerScope } from './reactive'
import { withBase } from './base'
import { readEvents } from './live'
import { pageData } from './page-data'
import { currentServerScope, isHydrating, onCleanup, ownSignal, tracking, untrack, whenHydrated } from './reactive'
import { decodeServerValue } from './wire'

// Defined by the browser build, which never runs the server's half: tested where it is read, so the bundler drops it.
declare const KAY_BROWSER: true | undefined

// What a keyed value is read by: text or a number, which are the same key.
export type LiveKey = string | number

// A value the server changes and every open page shows: read by calling it, as a signal is, and written with `set` on the server only.
export interface Live<T> {
  (): T
  // Changes the value for every page showing it; a function gets the current value. Throws in a browser, which only reads.
  set: Setter<T>
}

// A live value per key, `room(id)` reading one: what the declaration's function gives a key nothing was set for.
export interface LiveByKey<K extends LiveKey, T> {
  (key: K): T
  set: (key: K, next: T | ((current: T) => T)) => void
  // Puts a key back to what the declaration gives it, and frees what is kept for it.
  delete: (key: K) => void
}

// What both halves return for either shape; `live()` types the two apart for the app.
type Handle = Live<unknown> & LiveByKey<LiveKey, unknown>

// A value reaches the browser as devalue does, so a function cannot be one.
type PlainValue<T> = Exclude<T, (...args: never[]) => unknown>

// The page's script of live values: the ids it read with the signature the connection proves them by, and the value of each as the server rendered it.
export interface LivePage {
  ids: string[]
  sig: string
  values: [id: string, key: string, value: unknown][]
}

// What a live value changed to: its id, its key (empty for a global one) and the new value.
export type LiveUpdate = [id: string, key: string, value: unknown]

// What a connection asks for: the pages' proofs, and the keys it watches.
export interface LiveRequest {
  proofs: { ids: string[], sig: string }[]
  watch: [id: string, key: string][]
}

export const LIVE_ROUTE = '/_kay/live'
export const LIVE_SCRIPT = 'script[data-kay-live]'

// Another copy of this module, such as a workspace's second install or a dev reload, shares the one registry.
const REGISTRY = Symbol.for('kay.live')
// How long a browser waits after the values it reads change before it opens, moves or closes its connection, so the islands of a page and a swap share one.
const SETTLE_MS = 30

interface ServerSlot {
  id: string
  initial: unknown
  keyed: boolean
  values: Map<string, unknown>
  listeners: Map<string, Set<() => void>>
}

function slots(): Map<string, ServerSlot> {
  const holder = globalThis as Record<symbol, Map<string, ServerSlot> | undefined>

  return holder[REGISTRY] ??= new Map<string, ServerSlot>()
}

// The server's slot of a value, by id; the connection reads and watches values through it.
export function liveSlot(id: string): ServerSlot | undefined {
  return slots().get(id)
}

// What a declaration gives a key nothing was set for.
function initialOf(slot: { keyed: boolean, initial: unknown }, key: string): unknown {
  return slot.keyed ? (slot.initial as (key: string) => unknown)(key) : slot.initial
}

// The current value of a slot's key.
export function slotValue(slot: ServerSlot, key: string): unknown {
  return slot.values.has(key) ? slot.values.get(key) : initialOf(slot, key)
}

// Calls `listener` whenever the key changes; gives what stops it.
export function watchSlot(slot: ServerSlot, key: string, listener: () => void): () => void {
  let set = slot.listeners.get(key)

  if (!set)
    slot.listeners.set(key, set = new Set())

  set.add(listener)

  return () => {
    set.delete(listener)

    if (set.size === 0 && slot.listeners.get(key) === set)
      slot.listeners.delete(key)
  }
}

let checkWrite: ((id: string, value: unknown) => void) | undefined

// Installed by the server: refuses a value a browser could not be sent where it is set.
export function checkLiveWrites(check: (id: string, value: unknown) => void): void {
  checkWrite = check
}

function keyText(key: LiveKey): string {
  return String(key)
}

function notify(slot: ServerSlot, key: string): void {
  for (const listener of slot.listeners.get(key) ?? [])
    listener()
}

function serverLive(id: string, initial: unknown): Handle {
  const keyed = typeof initial === 'function'
  const known = slots().get(id)
  // A dev reload evaluates the module again: the values and watchers stay, the declaration is the new one.
  const slot: ServerSlot = known ?? { id, initial, keyed, values: new Map(), listeners: new Map() }

  if (known) {
    known.initial = initial
    known.keyed = keyed

    if (!keyed)
      known.values.delete('')
  }

  slots().set(id, slot)

  const read = (key: string): unknown => {
    const value = slotValue(slot, key)

    noteRead(slot, key, value)

    return value
  }

  const write = (key: string, next: unknown): void => {
    const current = slotValue(slot, key)
    const value = typeof next === 'function' ? (next as (current: unknown) => unknown)(current) : next

    if (Object.is(value, current))
      return

    checkWrite?.(slot.id, value)
    slot.values.set(key, value)
    notify(slot, key)
  }

  const handle = keyed ? (key: LiveKey) => read(keyText(key)) : () => read('')

  return Object.assign(handle, keyed
    ? {
      set: (key: LiveKey, next: unknown) => write(keyText(key), next),
      delete: (key: LiveKey) => {
        slot.values.delete(keyText(key))
        notify(slot, keyText(key))
      },
    }
    : { set: (next: unknown) => write('', next) }) as unknown as Handle
}

// A render of a page lists what it read, for its script and the proof of it.
function noteRead(slot: ServerSlot, key: string, value: unknown): void {
  const scope: ServerScope | undefined = currentServerScope()

  if (scope === undefined)
    return

  const reads = scope.live ??= new Map()
  const at = `${slot.id}\0${key}`

  if (!reads.has(at))
    reads.set(at, { id: slot.id, key, value })
}

interface Entry {
  read: () => unknown
  write: (value: unknown) => void
  // The value the page rendered it with, which an island claiming its markup reads whatever arrived since.
  rendered: { value: unknown } | undefined
  // Read while an island claims its markup, so the value that arrived since shows once it is hydrated.
  hydrated: () => number
  bump: () => void
  bumping: boolean
  watchers: number
}

interface BrowserSlot {
  id: string
  initial: unknown
  keyed: boolean
  entries: Map<string, Entry>
}

const browserSlots = new Map<string, BrowserSlot>()
// The keys the open connection carries, and the ones the islands read now.
const wanted = new Map<string, number>()
let current: { keys: Set<string>, reader: ReturnType<typeof readEvents<LiveUpdate[]>> } | undefined
let settling: ReturnType<typeof setTimeout> | undefined

function pagesOf(): LivePage[] {
  return typeof document === 'undefined' ? [] : pageData<LivePage>(LIVE_SCRIPT, decodeServerValue)
}

function renderedValue(id: string, key: string): { value: unknown } | undefined {
  for (const page of pagesOf()) {
    const found = page.values.find(entry => entry[0] === id && entry[1] === key)

    if (found)
      return { value: found[2] }
  }

  return undefined
}

function entryOf(slot: BrowserSlot, key: string): Entry {
  let entry = slot.entries.get(key)

  if (!entry) {
    const rendered = renderedValue(slot.id, key)
    const [read, write] = ownSignal<unknown>(rendered ? rendered.value : initialOf(slot, key))
    const [hydrated, bump] = ownSignal(0)

    entry = { read, write, rendered, hydrated, bump: () => {
      entry!.bumping = false
      bump(untrack(hydrated) + 1)
    }, bumping: false, watchers: 0 }
    slot.entries.set(key, entry)
  }

  return entry
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b))
    return true

  try {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  catch {
    return false
  }
}

function watch(slot: BrowserSlot, key: string, entry: Entry): void {
  const at = `${slot.id}\0${key}`

  if (entry.watchers === 0) {
    // A page rendered since may hold a fresher value than the last the connection delivered; the same render as before holds the one the connection has since moved past.
    const rendered = renderedValue(slot.id, key)

    if (rendered && !(entry.rendered && sameValue(entry.rendered.value, rendered.value))) {
      entry.rendered = rendered
      whenHydrated(() => entry.write(rendered.value))
    }
  }

  entry.watchers++
  wanted.set(at, (wanted.get(at) ?? 0) + 1)
  settle()

  onCleanup(() => {
    entry.watchers--

    const left = (wanted.get(at) ?? 1) - 1

    if (left <= 0)
      wanted.delete(at)
    else
      wanted.set(at, left)

    settle()
  })
}

function settle(): void {
  clearTimeout(settling)
  settling = setTimeout(sync, SETTLE_MS)
}

// Opens, moves or closes the one connection so it carries exactly the keys the islands read.
function sync(): void {
  settling = undefined

  const keys = new Set(wanted.keys())

  if (keys.size === 0) {
    current?.reader.close()
    current = undefined

    return
  }

  if (current && current.keys.size === keys.size && [...keys].every(key => current!.keys.has(key)))
    return

  current?.reader.close()

  const proofs = pagesOf().map(page => ({ ids: page.ids, sig: page.sig }))
  const watched: [string, string][] = [...keys].map(key => key.split('\0') as [string, string])
  const body = JSON.stringify({ proofs, watch: watched } satisfies LiveRequest)
  const reader = readEvents<LiveUpdate[]>(async signal => fetch(withBase(LIVE_ROUTE), { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }), true)

  reader.on(apply)
  current = { keys, reader }
  reader.start()
}

function apply(updates: LiveUpdate[]): void {
  for (const [id, key, value] of updates) {
    const entry = browserSlots.get(id)?.entries.get(key)

    if (entry)
      entry.write(value)
  }
}

function browserLive(id: string, initial: unknown): Handle {
  const keyed = typeof initial === 'function'
  const known = browserSlots.get(id)
  const slot: BrowserSlot = known ?? { id, initial, keyed, entries: new Map() }

  if (known) {
    known.initial = initial
    known.keyed = keyed
  }

  browserSlots.set(id, slot)

  const read = (key: string): unknown => {
    const entry = entryOf(slot, key)

    if (tracking())
      watch(slot, key, entry)

    if (isHydrating() && entry.rendered) {
      entry.hydrated()

      if (!entry.bumping) {
        entry.bumping = true
        whenHydrated(entry.bump)
      }

      return entry.rendered.value
    }

    return entry.read()
  }

  const refuse = (): never => {
    throw new TypeError(`kay: the live value ${id} is changed on the server, not in a browser`)
  }

  return Object.assign(keyed ? (key: LiveKey) => read(keyText(key)) : () => read(''), { set: refuse, ...keyed && { delete: refuse } }) as unknown as Handle
}

// A value the server changes and every page showing it follows: `export const visitors = live(0)` in a module, read in a template as `{visitors()}`, written on the server with `visitors.set(n => n + 1)`.
// Given a function of a key it is one value per key, `export const room = live((id: string) => ({ users: 0 }))`, read as `room(id)` and written as `room.set(id, ...)`.
// The build gives each declaration its id, so it is written as `export const name = live(...)` at the top of a module.
export function live<T>(initial: PlainValue<T>): Live<T>
export function live<K extends LiveKey, T>(initial: (key: K) => PlainValue<T>): LiveByKey<K, T>
export function live(initial: unknown, id?: string): unknown {
  if (id === undefined)
    throw new TypeError('kay: live() is declared as `export const name = live(...)` at the top of a module in the project, where the build names it')

  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? serverLive(id, initial) : browserLive(id, initial)
}
