import type { Action } from './action'
import { encodeCall } from './action'
import { withBase } from './base'
import { RETRY_LATER } from './local-status'
import { createSignal, getOwner, onCleanup } from './reactive'
import { FAILURE_HEADER, PAGE_HEADER, REDIRECT_HEADER } from './swap'
import { decodeServerValue } from './wire'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

export type LocalStatus = 'loading' | 'synced' | 'pending' | 'offline' | 'signed-out' | 'unavailable'

// What the island sees of a write the server did not take as it was: refused (`rejected`, the row went back to what the server last gave) or met a newer row (`conflict`, `kept` is the row now shown, undefined when the server's own).
export interface LocalIssue<Row> {
  id: number
  kind: 'rejected' | 'conflict'
  key: string
  op: 'put' | 'remove'
  status?: number | undefined
  errors?: Record<string, string> | undefined
  data?: unknown
  mine?: Row | undefined
  theirs?: Row | undefined
  kept?: Row | undefined
  at: number
}

export interface LocalConflict<Row> {
  key: string
  // The row as the server last gave it to this browser, undefined for a row made here.
  base: Row | undefined
  // The queued write's row, undefined when it was a removal.
  mine: Row | undefined
  // The server's row now, which its action answered `ctx.fail(409, row)` with.
  theirs: Row
}

export interface LocalOptions<Row extends object, Key extends keyof Row & string> {
  // The field naming a row: a string or a number.
  key: Key
  // The server's rows, read while online: after loading, after the queue was sent and on `sync()`.
  read: () => Promise<readonly Row[]> | readonly Row[]
  // The action a write of a row replays through, so its guards, schema and limits apply as to any call.
  put: Action<Row, unknown>
  remove?: Action<Pick<Row, Key>, unknown> | undefined
  // Changing it forgets the rows held in the browser, which are read again; the queue is kept.
  version?: number | undefined
  // Chooses the row to keep when the server's action answered 409 with its own: the default takes the server's row and puts this write's changed fields on it. Undefined takes the server's row as it is.
  conflict?: ((conflict: LocalConflict<Row>) => Row | undefined) | undefined
}

export interface Local<Row, Key extends keyof Row> {
  // The rows held, in key order, reactive.
  rows: () => readonly Row[]
  get: (key: Row[Key]) => Row | undefined
  // Both keep the change in the browser at once and resolve then; the server gets it when it can.
  put: (row: Row) => Promise<void>
  remove: (key: Row[Key]) => Promise<void>
  // Writes the server has not taken yet.
  pending: () => number
  status: () => LocalStatus
  issues: () => readonly LocalIssue<Row>[]
  dismiss: (id: number) => Promise<void>
  // Sends the queue and reads the server's rows again.
  sync: () => Promise<void>
  // Forgets this collection's rows, queue and issues in the browser.
  clear: () => Promise<void>
}

interface RowRecord {
  c: string
  k: string
  row: object
  base: object | undefined
  gone: boolean
}

interface Answer {
  status: number
  failure: string | null
  body: string
}

interface Entry {
  seq?: number
  c: string
  id: string
  op: 'put' | 'remove'
  k: string
  url: string
  headers: Record<string, string>
  body: string
  row: object
  tries: number
  // The sign-out token the write was made under: a write of someone who signed out since is never sent.
  cleared: string
  faults?: number | undefined
  answer?: Answer | undefined
}

const DATABASE = 'kay-local'
const CHANNEL = 'kay-local'
const SYNC_TAG = 'kay-local'
const LOCK = 'kay-local'
const CLEAR_COOKIE = 'kay_local_clear'
const MOST_CONFLICTS = 3
const RETRY_MS = [5000, 15_000, 60_000, 300_000]
// A write answered with one of these may succeed later, so it stays queued.
const TRANSIENT = new Set<number>(RETRY_LATER)
// A write the server answers 5xx this many times is rejected, so one that always throws does not hold the queue forever.
const MOST_FAULTS = 5
// The issues kept per collection: the oldest go first, so a page nobody dismisses on does not fill the browser.
const MOST_ISSUES = 50
// A request or a read of the server taking longer is given up as offline, as it holds the lock every tab and the worker send under.
const MOST_WAIT_MS = 30_000

function onServer(): boolean {
  return typeof KAY_BROWSER === 'undefined' && typeof indexedDB === 'undefined'
}

async function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result)
    source.onerror = () => reject(source.error)
  })
}

async function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('kay: the local transaction was aborted'))
  })
}

let opened: Promise<IDBDatabase> | undefined

async function database(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1)

    open.onupgradeneeded = () => {
      const db = open.result

      db.createObjectStore('rows', { keyPath: ['c', 'k'] }).createIndex('c', 'c')
      db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }).createIndex('c', 'c')
      db.createObjectStore('issues', { keyPath: 'id', autoIncrement: true }).createIndex('c', 'c')
      db.createObjectStore('meta', { keyPath: 'c' })
    }
    open.onsuccess = () => {
      // Another version of the database asking to upgrade is let in, the next use opening it again.
      open.result.onversionchange = () => {
        open.result.close()
        opened = undefined
      }
      resolve(open.result)
    }
    open.onerror = () => {
      opened = undefined
      reject(open.error)
    }
  })

  return opened
}

// One channel for every collection: tabs and the worker say which collection changed, or that answers were recorded.
const listeners = new Set<(message: string) => void>()
let channel: BroadcastChannel | undefined

function announce(c: string): void {
  channel ??= listen()
  channel.postMessage(c)

  for (const listener of listeners)
    listener(c)
}

function listen(): BroadcastChannel {
  const made = new BroadcastChannel(CHANNEL)

  made.onmessage = (event: MessageEvent<string>) => {
    for (const listener of listeners)
      listener(event.data)
  }

  return made
}

async function locked(work: () => Promise<void>): Promise<void> {
  if ('locks' in navigator)
    await navigator.locks.request(LOCK, work)
  else
    await work()
}

let registration: Promise<ServiceWorkerRegistration | undefined> | undefined

// Asks the browser to send the queue when it is online again, even with every tab closed; where it cannot, the page does on load and when the connection returns.
async function wake(): Promise<void> {
  if (!('serviceWorker' in navigator))
    return

  registration ??= navigator.serviceWorker.ready

  try {
    const ready = await registration as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }

    await ready.sync?.register(SYNC_TAG)
  }
  catch {}
}

// A database closed under the page, as a browser clearing the site's data does, ends the work in flight without a report.
async function quiet(work: () => Promise<void>): Promise<void> {
  try {
    await work()
  }
  catch (error) {
    if (!(error instanceof DOMException && error.name === 'InvalidStateError'))
      throw error
  }
}

function clearToken(): string {
  const found = document.cookie.split('; ').find(part => part.startsWith(`${CLEAR_COOKIE}=`))

  return found === undefined ? '' : found.slice(CLEAR_COOKIE.length + 1)
}

function same(a: unknown, b: unknown): boolean {
  if (a === b)
    return true

  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime()

  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return false

  const left = Object.keys(a)

  return left.length === Object.keys(b).length && left.every(name => same((a as Record<string, unknown>)[name], (b as Record<string, unknown>)[name]))
}

// The server's row with the fields this write changed from the row it started from put on it.
function merged<Row extends object>(base: Row | undefined, mine: Row | undefined, theirs: Row): Row | undefined {
  if (mine === undefined)
    return undefined

  // A row made here met a server row it never saw: the guard that answered 409 would refuse this write again, so the server's row stands and the issue shows the write.
  if (base === undefined)
    return undefined

  const out = { ...theirs } as Record<string, unknown>

  for (const [name, value] of Object.entries(mine)) {
    if (!same(value, (base as Record<string, unknown>)[name]))
      out[name] = value
  }

  for (const name of Object.keys(base)) {
    if (!(name in mine))
      delete out[name]
  }

  return out as Row
}

function inert<Row, Key extends keyof Row>(): Local<Row, Key> {
  const refuse = async () => Promise.reject(new Error('kay: a local() collection is written in the browser only'))
  const nothing = async () => Promise.resolve()

  return { rows: () => [], get: () => undefined, put: refuse, remove: refuse, pending: () => 0, status: () => 'loading', issues: () => [], dismiss: nothing, sync: nothing, clear: nothing }
}

// A collection the island reads and writes at once, kept in IndexedDB so it works offline: a write is applied in the browser and queued, then replayed through the collection's action, once, when the server can be reached.
export function local<Row extends object, const Key extends keyof Row & string>(options: LocalOptions<Row, Key>): Local<Row, Key> {
  return onServer() ? inert() : new Collection(options).api()
}

class Collection<Row extends object, Key extends keyof Row & string> {
  private readonly c: string
  private readonly options: LocalOptions<Row, Key>
  private readonly view = createSignal<{ list: Row[], byKey: Map<string, Row> }>({ list: [], byKey: new Map() })
  private readonly count = createSignal(0)
  private readonly problems = createSignal<LocalIssue<Row>[]>([])
  private readonly state = createSignal<LocalStatus>('loading')
  private offline = false
  private paused = false
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  // Counts what changed the queue, so a read of the server that began before is not applied over it.
  private changes = 0
  private ready: Promise<void>
  private token = ''
  private disposers: (() => void)[] = []
  private ended = false
  // The last read of the server failed, so a retry is due though nothing is queued.
  private unread = false

  constructor(options: LocalOptions<Row, Key>) {
    this.options = options
    this.c = options.put.url
    this.ready = this.start()

    if (getOwner())
      onCleanup(() => this.dispose())
  }

  private dispose(): void {
    this.ended = true
    clearTimeout(this.timer)

    for (const undo of this.disposers)
      undo()
  }

  api(): Local<Row, Key> {
    return {
      rows: () => this.view[0]().list,
      get: key => this.view[0]().byKey.get(String(key)),
      put: async row => this.write('put', row),
      remove: async key => this.write('remove', { [this.options.key]: key } as Row),
      pending: this.count[0],
      status: this.state[0],
      issues: this.problems[0],
      dismiss: async id => this.dismiss(id),
      sync: async () => this.sync(),
      clear: async () => this.clear(),
    }
  }

  private async start(): Promise<void> {
    try {
      const db = await database()
      const token = clearToken()
      const { c } = this
      const tx = db.transaction(['rows', 'outbox', 'issues', 'meta'], 'readwrite')
      const meta = await request(tx.objectStore('meta').get(c)) as { version: number, cleared: string } | undefined
      const version = this.options.version ?? 1

      // Someone signed out here since, so what they wrote goes with them; or the rows' shape changed, and the server's are read again.
      if (meta !== undefined && token !== '' && meta.cleared !== token)
        await this.wipe(tx, true)
      else if (meta !== undefined && meta.version !== version)
        await this.wipe(tx, false)

      this.token = token !== '' ? token : (meta?.cleared ?? '')
      tx.objectStore('meta').put({ c, version, cleared: this.token })
      await finished(tx)
      await this.reload()
    }
    catch {
      this.state[1]('unavailable')

      return
    }

    if (this.ended)
      return

    const heard = (message: string) => void quiet(async () => this.heard(message))
    const online = () => void this.sync()
    const offline = () => this.noticed(true)
    const visible = () => {
      if (document.visibilityState === 'visible')
        void this.sync()
    }

    listeners.add(heard)
    channel ??= listen()
    addEventListener('online', online)
    addEventListener('offline', offline)
    document.addEventListener('visibilitychange', visible)
    this.disposers.push(() => {
      listeners.delete(heard)
      removeEventListener('online', online)
      removeEventListener('offline', offline)
      document.removeEventListener('visibilitychange', visible)
    })

    void this.run(true)
  }

  private async wipe(tx: IDBTransaction, queue: boolean): Promise<void> {
    const only = IDBKeyRange.only(this.c)

    for (const name of queue ? ['rows', 'outbox', 'issues'] : ['rows']) {
      const index = tx.objectStore(name).index('c')

      for (const key of await request(index.getAllKeys(only)))
        tx.objectStore(name).delete(key)
    }
  }

  private async heard(message: string): Promise<void> {
    // Settled elsewhere: a read of the server that began before is older than the queue.
    this.changes++

    if (message === this.c) {
      await this.reload()
    }
    else if (message === 'answered') {
      await this.sync()
    }
  }

  private noticed(offline: boolean): void {
    this.offline = offline
    this.show()
  }

  private show(count = this.count[0]()): void {
    if (this.state[0]() === 'unavailable')
      return

    if (this.paused)
      this.state[1]('signed-out')
    else if (this.offline)
      this.state[1]('offline')
    else
      this.state[1](count > 0 ? 'pending' : 'synced')
  }

  // Reads the rows, the queue's size and the issues of this collection from the database into the signals.
  private async reload(): Promise<void> {
    const db = await database()
    const tx = db.transaction(['rows', 'outbox', 'issues'])
    const only = IDBKeyRange.only(this.c)
    const [rows, queued, issues] = await Promise.all([
      request(tx.objectStore('rows').index('c').getAll(only)) as Promise<RowRecord[]>,
      request(tx.objectStore('outbox').index('c').count(only)),
      request(tx.objectStore('issues').index('c').getAll(only)) as Promise<(LocalIssue<Row> & { c: string })[]>,
    ])
    const live = rows.filter(record => !record.gone)

    this.view[1]({ list: live.map(record => record.row as Row), byKey: new Map(live.map(record => [record.k, record.row as Row])) })
    this.count[1](queued)
    this.problems[1](issues.map(({ c: _, ...issue }) => issue))
    this.show(queued)
  }

  private async write(op: 'put' | 'remove', row: Row): Promise<void> {
    if (op === 'remove' && this.options.remove === undefined)
      throw new TypeError('kay: this local() collection declares no remove action')

    await this.ready

    if (this.state[0]() === 'unavailable')
      throw new Error('kay: this browser keeps no IndexedDB, so a local() collection cannot be written')

    const keyed = row[this.options.key]

    if (typeof keyed !== 'string' && typeof keyed !== 'number')
      throw new TypeError(`kay: a local() row names itself by a string or a number in \`${this.options.key}\``)

    const { headers, body } = encodeCall(row)

    if (typeof body !== 'string')
      throw new TypeError('kay: a local() row cannot hold files')

    const k = String(keyed)
    const action = op === 'put' ? this.options.put : this.options.remove!
    const sent: Record<string, string> = { ...headers, ...typeof location !== 'undefined' && { [PAGE_HEADER]: location.pathname + location.search } }
    const db = await database()
    const tx = db.transaction(['rows', 'outbox'], 'readwrite')
    const rows = tx.objectStore('rows')
    const before = await request(rows.get([this.c, k])) as RowRecord | undefined

    this.changes++
    rows.put({ c: this.c, k, row: op === 'put' ? row : (before?.row ?? row), base: before?.base, gone: op === 'remove' } satisfies RowRecord)
    tx.objectStore('outbox').add({ c: this.c, id: crypto.randomUUID(), op, k, url: withBase(action.url), headers: sent, body, row, tries: 0, cleared: this.token } satisfies Entry)
    await finished(tx)
    await this.reload()
    announce(this.c)
    void wake()
    void this.sync(false)
  }

  private async dismiss(id: number): Promise<void> {
    const db = await database()
    const tx = db.transaction('issues', 'readwrite')

    tx.objectStore('issues').delete(id)
    await finished(tx)
    await this.reload()
    announce(this.c)
  }

  private async clear(): Promise<void> {
    await this.ready

    const db = await database()
    const tx = db.transaction(['rows', 'outbox', 'issues'], 'readwrite')

    this.changes++
    await this.wipe(tx, true)
    await finished(tx)
    await this.reload()
    announce(this.c)
  }

  // Sends the queue, then (with `refresh`) reads the server's rows.
  private async sync(refresh = true): Promise<void> {
    await this.ready
    await this.run(refresh)
  }

  private async run(refresh: boolean): Promise<void> {
    if (this.ended || this.state[0]() === 'unavailable')
      return

    clearTimeout(this.timer)
    this.paused = false

    await quiet(async () => locked(async () => {
      await this.advance()

      if (refresh && !this.offline && !this.paused)
        await this.refresh()
    }))

    this.retry()
  }

  private retry(): void {
    if (this.ended)
      return

    if ((this.count[0]() === 0 && !this.unread) || this.paused) {
      this.failures = 0

      return
    }

    if (this.offline) {
      clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.sync(), RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)])
    }
  }

  private async first(): Promise<Entry | undefined> {
    const db = await database()

    return request(db.transaction('outbox').objectStore('outbox').index('c').get(IDBKeyRange.only(this.c))) as Promise<Entry | undefined>
  }

  private async advance(): Promise<void> {
    for (;;) {
      let entry = await this.first()

      if (entry === undefined) {
        this.offline = false

        break
      }

      if (entry.answer === undefined) {
        const answer = await this.send(entry)

        if (answer === undefined)
          break

        entry = { ...entry, answer }
        await this.record(entry)
      }

      if (!await this.apply(entry)) {
        break
      }
    }

    await this.reload()
  }

  // Sends one write as the action's own call would, with its write id for the server to run it once; undefined when the server could not be reached or asked to wait.
  private async send(entry: Entry): Promise<Answer | undefined> {
    let response: Response

    try {
      response = await fetch(entry.url, { method: 'POST', credentials: 'same-origin', redirect: 'manual', signal: AbortSignal.timeout(MOST_WAIT_MS), headers: { ...entry.headers, 'x-kay-write': entry.id }, body: entry.body })
    }
    catch {
      this.noticed(true)

      return undefined
    }

    this.offline = false

    if (response.type === 'opaqueredirect' || response.headers.has(REDIRECT_HEADER) || response.status === 401) {
      this.paused = true
      this.show()

      return undefined
    }

    if (response.status >= 500 && (entry.faults ?? 0) + 1 >= MOST_FAULTS)
      return { status: response.status, failure: null, body: await response.text() }

    if (response.status >= 500 || TRANSIENT.has(response.status)) {
      if (response.status >= 500)
        await this.record({ ...entry, faults: (entry.faults ?? 0) + 1 })

      this.noticed(true)

      return undefined
    }

    return { status: response.status, failure: response.headers.get(FAILURE_HEADER), body: await response.text() }
  }

  private async record(entry: Entry): Promise<void> {
    const db = await database()
    const tx = db.transaction('outbox', 'readwrite')

    tx.objectStore('outbox').put(entry)
    await finished(tx)
  }

  // Settles one answered write against the rows, in one transaction; false stops the queue.
  private async apply(entry: Entry): Promise<boolean> {
    const { answer } = entry
    const db = await database()
    const tx = db.transaction(['rows', 'outbox', 'issues'], 'readwrite')
    const rows = tx.objectStore('rows')
    const outbox = tx.objectStore('outbox')
    const current = await request(rows.get([this.c, entry.k])) as RowRecord | undefined

    this.changes++

    if (answer === undefined)
      return false

    if (answer.status >= 200 && answer.status < 300) {
      outbox.delete(entry.seq!)

      const others = (await request(outbox.index('c').getAll(IDBKeyRange.only(this.c))) as Entry[]).filter(other => other.k === entry.k && other.seq !== entry.seq)

      if (entry.op === 'put' && current !== undefined) {
        // An action answering with the row it stored, server-set fields included, has it taken as the server's.
        const result = answer.body === '' ? undefined : decodeServerValue(answer.body)
        const stored = typeof result === 'object' && result !== null && String((result as Record<string, unknown>)[this.options.key]) === entry.k ? result : undefined

        rows.put({ ...current, base: stored ?? entry.row, ...stored !== undefined && others.length === 0 && !current.gone && { row: stored } })
      }
      else if (entry.op === 'remove' && others.length === 0) {
        rows.delete([this.c, entry.k])
      }
      else if (entry.op === 'remove' && current !== undefined) {
        rows.put({ ...current, base: undefined })
      }

      await finished(tx)

      return true
    }

    const failed = answer.failure === null ? {} : decodeServerValue(answer.body) as { errors?: Record<string, string>, data?: unknown }

    if (answer.status === 409 && typeof failed.data === 'object' && failed.data !== null && entry.tries < MOST_CONFLICTS)
      return this.conflicted(tx, entry, current, failed.data as Row)

    const issues = tx.objectStore('issues')

    outbox.delete(entry.seq!)

    // Back to what the server last gave, or gone for a row it never knew.
    if (current?.base !== undefined)
      rows.put({ ...current, row: current.base, gone: false })
    else
      rows.delete([this.c, entry.k])

    issues.add({ c: this.c, kind: 'rejected', key: entry.k, op: entry.op, status: answer.status, errors: failed.errors, data: failed.data, mine: entry.op === 'put' ? entry.row : undefined, at: Date.now() })
    await this.trim(issues)
    await finished(tx)

    return true
  }

  private async conflicted(tx: IDBTransaction, entry: Entry, current: RowRecord | undefined, theirs: Row): Promise<boolean> {
    const rows = tx.objectStore('rows')
    const mine = entry.op === 'put' ? entry.row as Row : undefined
    const base = current?.base as Row | undefined
    const detail = { key: entry.k, base, mine, theirs }
    const kept = this.options.conflict === undefined ? merged(base, mine, theirs) : this.options.conflict(detail)
    const issue = { c: this.c, kind: 'conflict', key: entry.k, op: entry.op, mine, theirs, kept: kept === undefined || same(kept, theirs) ? undefined : kept, at: Date.now() }

    tx.objectStore('issues').add(issue)

    if (kept === undefined || same(kept, theirs)) {
      tx.objectStore('outbox').delete(entry.seq!)
      rows.put({ c: this.c, k: entry.k, row: theirs, base: theirs, gone: false })
    }
    else {
      // The merged row goes in place of the write that met the newer one, as a new write.
      const { headers, body } = encodeCall(kept)

      rows.put({ c: this.c, k: entry.k, row: kept, base: theirs, gone: false })
      tx.objectStore('outbox').put({ ...entry, id: crypto.randomUUID(), op: 'put', url: withBase(this.options.put.url), headers: { ...entry.headers, ...headers }, body: body as string, row: kept, tries: entry.tries + 1, answer: undefined })
    }

    await this.trim(tx.objectStore('issues'))
    await finished(tx)

    return true
  }

  // Drops this collection's oldest issues beyond the most kept.
  private async trim(issues: IDBObjectStore): Promise<void> {
    const keys = await request(issues.index('c').getAllKeys(IDBKeyRange.only(this.c)))

    for (const key of keys.slice(0, Math.max(0, keys.length - MOST_ISSUES)))
      issues.delete(key)
  }

  // Takes the server's rows in, leaving any row with a write queued.
  private async refresh(): Promise<void> {
    const seen = this.changes
    let server: readonly Row[]

    try {
      server = await Promise.race([this.options.read(), new Promise<never>((_, reject) => setTimeout(reject, MOST_WAIT_MS, new Error('kay: the local() read took too long')))])
    }
    catch {
      this.unread = true
      this.noticed(true)

      return
    }

    this.unread = false

    // A write was made or settled while the server answered: its rows are older than the queue, and the next sync reads again.
    if (seen !== this.changes)
      return

    const db = await database()
    const tx = db.transaction(['rows', 'outbox'], 'readwrite')
    const rows = tx.objectStore('rows')
    const only = IDBKeyRange.only(this.c)
    const queued = new Set((await request(tx.objectStore('outbox').index('c').getAll(only)) as Entry[]).map(entry => entry.k))
    const held = await request(rows.index('c').getAll(only)) as RowRecord[]
    const given = new Set<string>()

    for (const row of server) {
      const k = String(row[this.options.key])

      given.add(k)

      if (!queued.has(k))
        rows.put({ c: this.c, k, row, base: row, gone: false } satisfies RowRecord)
    }

    // A row the server no longer has and nothing here wrote.
    for (const record of held) {
      if (!given.has(record.k) && !queued.has(record.k))
        rows.delete([this.c, record.k])
    }

    await finished(tx)
    await this.reload()
    announce(this.c)
  }
}
