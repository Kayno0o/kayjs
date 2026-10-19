import type { Setter } from './index'
import type { PlainValue, ServerScope } from './reactive'
import { withBase } from './base'
import { readEvents } from './live'
import { pageData } from './page-data'
import { currentServerScope, isHydrating, onCleanup, ownSignal, tracking, untrack, whenHydrated } from './reactive'
import { decodeServerValue } from './wire'

// Defined by the browser build, which never runs the server's half: tested where it is read, so the bundler drops it.
declare const KAY_BROWSER: true | undefined

// What a keyed value is read by.
export type LiveKey = string

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

// The page's script of live values: the value of each as the server rendered it, with the signature that proves the page read those keys.
export interface LivePage {
  // When the server made the proof, in milliseconds: it takes it for `PROOF_LIFETIME_MS`.
  at: number
  sig: string
  values: [id: string, key: string, value: unknown][]
}

// What a live value changed to: its id, its key (empty for a global one) and the new value.
export type LiveUpdate = [id: string, key: string, value: unknown]

// What a connection asks for: the pages' proofs, and the keys it watches.
export interface LiveRequest {
  proofs: { keys: [id: string, key: string][], at: number, sig: string }[]
  watch: [id: string, key: string][]
}

export const LIVE_ROUTE = '/_kay/live'
export const LIVE_SCRIPT = 'script[data-kay-live]'
const RENEW_RETRY_MS = 60_000
// How long a page that no longer holds live values waits before asking again after a refusal: the proof it has will not be taken again.
const GONE_RETRY_MS = 5 * 60_000

// How long the server takes a page's proof, and so how long a page may watch on it before asking for another.
export const PROOF_LIFETIME_MS = 60 * 60_000

// Another copy of this module, such as a workspace's second install or a dev reload, shares the one registry.
const REGISTRY = Symbol.for('kay.live')
// How long a browser waits after the values it reads change before it opens, moves or closes its connection, so the islands of a page and a swap share one.
const SETTLE_MS = 30

interface ServerSlot {
  id: string
  // The constant it is declared as, which only the server knows: what its errors call it by.
  name: string | undefined
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

let checkWrite: ((label: string, value: unknown) => void) | undefined

// Installed by the server: refuses a value a browser could not be sent where it is set.
export function checkLiveWrites(check: (label: string, value: unknown) => void): void {
  checkWrite = check
}

function keyText(key: LiveKey): string {
  return String(key)
}

function notify(slot: ServerSlot, key: string): void {
  for (const listener of slot.listeners.get(key) ?? [])
    listener()
}

const slotOfHandle = new WeakMap<object, ServerSlot>()

// An island's server render notes the live values it imports, so the page proves them though the render did not read them, as when a handler or a `--- client` fence reads one later. A keyed value is left out: its key is not known before it is read.
export function noteLives(handles: readonly unknown[]): void {
  for (const handle of handles) {
    const slot = typeof handle === 'function' ? slotOfHandle.get(handle) : undefined

    if (slot !== undefined && !slot.keyed)
      noteRead(slot, '', slotValue(slot, ''))
  }
}

function serverLive(id: string, initial: unknown, name: string | undefined): Handle {
  const keyed = typeof initial === 'function'
  const known = slots().get(id)
  // A dev reload evaluates the module again: the values and watchers stay, the declaration is the new one.
  const slot: ServerSlot = known ?? { id, name, initial, keyed, values: new Map(), listeners: new Map() }

  if (known) {
    known.initial = initial
    known.keyed = keyed
    known.name = name
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

    checkWrite?.(slot.name === undefined ? slot.id : `${slot.name} (${slot.id})`, value)
    slot.values.set(key, value)
    notify(slot, key)
  }

  const handle = keyed ? (key: LiveKey) => read(keyText(key)) : () => read('')

  slotOfHandle.set(handle, slot)

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
let renewing: ReturnType<typeof setTimeout> | undefined

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
  const at = JSON.stringify([slot.id, key])

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

// Resolves after `ms`, or as soon as `signal` aborts.
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)

    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }

    signal.addEventListener('abort', done)
  })
}

function settle(): void {
  clearTimeout(settling)
  settling = setTimeout(sync, SETTLE_MS)
}

// Asks for the page again and takes its live scripts in place of the page's own, so a proof the server no longer takes, or is about to stop taking, is replaced by one it made now; `gone` when the page no longer holds any, as one the visitor may not see, `failed` when it could not be asked.
async function renewProofs(signal: AbortSignal | null = null): Promise<'renewed' | 'gone' | 'failed'> {
  try {
    const response = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store', signal })

    if (!response.ok)
      return 'failed'

    const fresh = [...new DOMParser().parseFromString(await response.text(), 'text/html').querySelectorAll(LIVE_SCRIPT)]

    if (fresh.length === 0)
      return 'gone'

    for (const old of document.querySelectorAll(LIVE_SCRIPT))
      old.remove()

    for (const script of fresh)
      document.head.append(document.importNode(script, true))

    return 'renewed'
  }
  catch {
    return 'failed'
  }
}

// Gets the connection new proofs before the server stops taking the ones it opened with, counted on the browser's own clock as the server's may differ; a renewal that could not ask is tried again after a minute.
function renewLater(delay = PROOF_LIFETIME_MS / 2): void {
  clearTimeout(renewing)
  renewing = undefined

  if (pagesOf().length === 0)
    return

  const renew = async () => {
    renewing = undefined

    if (!current)
      return

    const renewed = await renewProofs()

    if (renewed === 'failed') {
      renewLater(RENEW_RETRY_MS)

      return
    }

    if (renewed === 'renewed') {
      current?.reader.close()
      current = undefined
      sync()
    }
  }

  renewing = setTimeout(() => void renew(), delay)
}

// Closes the connection and stops renewing its proof.
function release(): void {
  clearTimeout(renewing)
  renewing = undefined
  current?.reader.close()
  current = undefined
}

// Opens, moves or closes the one connection so it carries exactly the keys the islands read.
function sync(): void {
  settling = undefined

  const keys = new Set(wanted.keys())

  if (keys.size === 0) {
    release()

    return
  }

  if (document.hidden)
    return

  if (current && current.keys.size === keys.size && [...keys].every(key => current!.keys.has(key)))
    return

  current?.reader.close()

  const watched = [...keys].map(key => JSON.parse(key) as [string, string])
  // The proofs are read at each attempt, as a renewed page holds new ones.
  const post = async (signal: AbortSignal) => fetch(withBase(LIVE_ROUTE), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proofs: pagesOf().map(page => ({ keys: page.values.map(([id, key]) => [id, key] as [string, string]), at: page.at, sig: page.sig })), watch: watched } satisfies LiveRequest), signal })
  const reader = readEvents<LiveUpdate[]>(async (signal) => {
    const response = await post(signal)

    if (response.status !== 403)
      return response

    // Refused: the proof may be one a restart or its age made stale, so the page is asked for a new one before the backoff.
    const renewed = await renewProofs(signal)

    if (renewed === 'renewed')
      return post(signal)

    // The page no longer holds any, as for a visitor who may not see it: the stale proof is tried again at a distance.
    if (renewed === 'gone')
      await pause(GONE_RETRY_MS, signal)

    return response
  }, true, false, true)

  reader.on(apply)
  current = { keys, reader }

  if (renewing === undefined)
    renewLater()

  reader.start()
}

// A hidden tab holds no connection and renews no proof; shown again, it opens one that starts with every value as it is then.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden)
      release()
    else
      sync()
  })
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
export function live(initial: unknown, id?: string, name?: string): unknown {
  if (id === undefined)
    throw new TypeError('kay: live() is declared as `export const name = live(...)` at the top of a module in the project, where the build names it')

  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? serverLive(id, initial, name) : browserLive(id, initial)
}
