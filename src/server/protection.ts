import type { Server } from 'bun'
import type { Elysia, TSchema } from 'elysia'
import type { ProxyConfig } from '../config'
import type { ActionRateLimit, RateLimit, RateStore, RateWindow, ServerAction } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import { honeypotField, minTimeOf, STAMP_FIELD } from '../runtime/action'
import { durationSeconds } from '../runtime/duration'
import { openSqlite } from '../runtime/sqlite.server'
import { rewrittenAddress } from './rewrite'
import { stampTime } from './stamp'

export interface ProtectionRefusal {
  status: number
  // The field the message is for, `''` for the form as a whole.
  field: string
  message: string
  headers?: Record<string, string>
}

export interface RateLimiter {
  // Counts an attempt from the request's client, or under the app's own key such as an account id: the seconds it must wait before the next one once over the limit, else undefined. `server` is the one serving the request, read from `pages()`'s app when left out.
  hit: (from: Request | string, server?: Server<unknown> | null) => Promise<number | undefined>
}

// A post a honeypot caught, answered as if it went through.
export const PRETEND = 'pretend'

// The most windows a memory store keeps: past it, a new client makes room by dropping the expired windows, then the oldest ones.
const MAX_WINDOWS = 10_000
// How often the SQLite store sweeps the windows that closed.
const SWEEP_MS = 60_000
const ZONE = /%.*$/
const LEADING_ZEROS = /^0+(?=.)/
// Loopback, private, shared (CGNAT, Tailscale) and link-local ranges, IPv4 ones mapped into IPv6 included: where a proxy in front of the server connects from.
const LOOPBACK_OR_PRIVATE = /^(?:(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)|::1$|f[cd]|fe[89ab])/i
// The proxy settings of the app each request reached, set as it arrives; `null` for an app setting none.
const proxies = new WeakMap<Request, ProxyConfig | null>()
// The server each request came through, for `clientAddress` called where only the request is at hand, as in a guard.
const servers = new WeakMap<Request, Server<unknown>>()

interface ActionLimit {
  name: string
  limit: ActionRateLimit
}

// Each action's limits with the name each counts under, read once.
const limitLists = new WeakMap<object, ActionLimit[]>()
// One memory store per limit, so clients flooding one never push another's windows out, such as a login form's.
const memories = new Map<string, ReturnType<typeof memoryRates>>()
let warnedUnconfigured = false
const requestIds = new WeakMap<Request, string>()
// What an id a proxy passed on may hold, so it can neither forge a log line nor swell one.
const PASSED_ID = /^[\w.:+/=@-]{1,128}$/

// Each action's `minTime`, read once: `action()` refused one it cannot read.
const minTimes = new WeakMap<object, ReturnType<typeof minTimeOf>>()

function minTimesOf(protection: NonNullable<ServerAction<TSchema, unknown>['protection']>): ReturnType<typeof minTimeOf> {
  if (!minTimes.has(protection))
    minTimes.set(protection, minTimeOf(protection))

  return minTimes.get(protection)
}

// Each rate limit's window in milliseconds, read once: `action()` refused one it cannot read.
const windowLengths = new WeakMap<object, number>()

function windowMs(rateLimit: { window: Duration }): number {
  let ms = windowLengths.get(rateLimit)

  if (ms === undefined)
    windowLengths.set(rateLimit, ms = durationSeconds(rateLimit.window, 'rateLimit.window') * 1000)

  return ms
}

// Fixed windows per key in this process: enough to slow a script hammering a form, which is what a contact or login form needs.
export function memoryRates(): { hit: (key: string, windowMs: number) => RateWindow, peek: (key: string) => RateWindow | undefined } {
  // Ordered by when each window opened, so the oldest come first.
  const windows = new Map<string, RateWindow>()

  return {
    peek(key) {
      const window = windows.get(key)

      return window && window.resetAt > Date.now() ? { ...window } : undefined
    },
    hit(key, windowMs) {
      const now = Date.now()
      let window = windows.get(key)

      if (!window || window.resetAt <= now) {
        if (!window)
          makeRoom(windows, now)

        // Moved to the end, as the newest window.
        windows.delete(key)
        windows.set(key, window = { count: 0, resetAt: now + windowMs })
      }

      window.count++

      return { count: window.count, resetAt: window.resetAt }
    },
  }
}

// Windows kept in a SQLite file, so every process of the machine opening it counts the same attempts.
export function sqliteRates(path: string): RateStore {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_rates (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)')

  // The row's old values are what both cases read: a closed window opens afresh, an open one counts one more.
  const hit = db.query<{ count: number, reset_at: number }, [string, number, number]>('INSERT INTO kay_rates (key, count, reset_at) VALUES (?1, 1, ?2 + ?3) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN reset_at <= ?2 THEN 1 ELSE count + 1 END, reset_at = CASE WHEN reset_at <= ?2 THEN ?2 + ?3 ELSE reset_at END RETURNING count, reset_at')
  const peek = db.query<{ count: number, reset_at: number }, [string, number]>('SELECT count, reset_at FROM kay_rates WHERE key = ? AND reset_at > ?')
  const sweep = db.query('DELETE FROM kay_rates WHERE reset_at <= ?')
  let swept = 0

  return {
    hit(key, windowMs) {
      const now = Date.now()

      if (now - swept > SWEEP_MS) {
        swept = now
        sweep.run(now)
      }

      const row = hit.get(key, now, windowMs)!

      return { count: row.count, resetAt: row.reset_at }
    },
    peek(key) {
      const row = peek.get(key, Date.now())

      return row ? { count: row.count, resetAt: row.reset_at } : undefined
    },
  }
}

// A limit for a guard, an API route or a library, counted as an action's `rateLimit` is: `max` attempts from one client every `window`, under `name`, which limits sharing it count together.
export function rateLimit(name: string, limit: RateLimit): RateLimiter {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new Error(`kay: rateLimit('${name}')'s max is ${limit.max}; it takes a whole number of at least 1`)

  const ms = durationSeconds(limit.window, `rateLimit('${name}')'s window`) * 1000

  return {
    hit: async (from, server) => waitFor(await (limit.store ?? memoryOf(name)).hit(typeof from === 'string' ? `${name}\nkey:${from}` : limitKey(name, clientAddress(from, server)), ms), limit.max),
  }
}

function limitKey(name: string, client: string): string {
  return `${name}\n${rateKey(client)}`
}

// The action's limits, each counted under its own name: the first under the action's URL, the same in every process, the others under their place in the list.
function actionLimits(action: ServerAction<TSchema, unknown>): ActionLimit[] {
  let limits = limitLists.get(action)

  if (!limits)
    limitLists.set(action, limits = [action.protection?.rateLimit ?? []].flat().map((limit, index) => ({ name: index === 0 ? action.url : `${action.url}#${index}`, limit })))

  return limits
}

// Seconds until the next attempt may go through, or undefined while under the limit.
function waitFor(window: { count: number, resetAt: number }, max: number): number | undefined {
  return window.count > max ? Math.ceil((window.resetAt - Date.now()) / 1000) : undefined
}

// Why a post must not reach the handler, `PRETEND` for a bot to answer as if it went through, or undefined when it may.
// `plain` is a post the browser sent itself, which a form posting to the action always sends with its stamp; a call from kay's script may come from an island's form, which renders none.
export async function protectionRefusal(action: ServerAction<TSchema, unknown>, request: Request, body: unknown, form: boolean, server: Server<unknown> | null | undefined, plain = form): Promise<ProtectionRefusal | typeof PRETEND | undefined> {
  const { honeypot, messages } = action.protection ?? {}
  const field = honeypotField(action.protection)
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}

  if (form && field !== undefined && filledIn(fields[field])) {
    if (typeof honeypot === 'object' && honeypot.pretend)
      return PRETEND

    return { status: 422, field, message: messages?.honeypot ?? 'Leave this field empty' }
  }

  const minTime = action.protection && minTimesOf(action.protection)

  if (minTime && form && (plain || fields[STAMP_FIELD] !== undefined)) {
    const time = stampTime(action.url, fields[STAMP_FIELD])
    const age = time === undefined ? undefined : Date.now() - time

    if (age === undefined || age < minTime.after || age > minTime.maxAge) {
      if (minTime.pretend)
        return PRETEND

      // A stamp missing or forged is most often a page from before a restart, which changed the key: expired too.
      const reason = age !== undefined && age < minTime.after ? 'early' : 'expired'
      const message = messages?.minTime ?? (refusal => refusal === 'early' ? 'Sent too fast; take a moment, then send it again' : 'This form has expired; send it again')

      return { status: 422, field: '', message: typeof message === 'string' ? message : message(reason) }
    }
  }

  const limits = actionLimits(action)

  // Read only for an action limiting posts: reading it may warn about a proxy setting that only rate limits need.
  if (limits.length === 0)
    return undefined

  const client = clientAddress(request, server)
  let wait: number | undefined

  // Every limit counts the attempt, whichever refuses it, and the longest wait is the one to tell.
  for (const { name, limit } of limits) {
    const store = limit.store ?? memoryOf(name)
    const key = limitKey(name, client)
    // A limit on the posts that went through only reads its count here; the handler's success adds to it.
    const own = limit.count === 'succeeded' ? reached(await store.peek!(key), limit.max) : waitFor(await store.hit(key, windowMs(limit)), limit.max)

    if (own !== undefined && (wait === undefined || own > wait))
      wait = own
  }

  if (wait === undefined)
    return undefined

  const message = messages?.rateLimit ?? (seconds => `Too many attempts; try again in ${seconds} s`)

  return { status: 429, field: '', message: typeof message === 'string' ? message : message(wait), headers: { 'retry-after': String(wait) } }
}

// Counts a post whose handler went through against the action's limits on those.
export async function countSucceeded(action: ServerAction<TSchema, unknown>, request: Request, server: Server<unknown> | null | undefined): Promise<void> {
  const limits = actionLimits(action).filter(({ limit }) => limit.count === 'succeeded')

  if (limits.length === 0)
    return

  const client = clientAddress(request, server)

  for (const { name, limit } of limits)
    await (limit.store ?? memoryOf(name)).hit(limitKey(name, client), windowMs(limit))
}

// Seconds until the window closes once `max` posts went through in it, or undefined while fewer did.
function reached(window: RateWindow | undefined, max: number): number | undefined {
  return window && window.count >= max ? Math.ceil((window.resetAt - Date.now()) / 1000) : undefined
}

// Something a person never types into a field they cannot see: text, several values, or a file.
function filledIn(value: unknown): boolean {
  if (Array.isArray(value))
    return value.some(filledIn)

  if (value instanceof Blob)
    return value.size > 0

  return typeof value === 'string' ? value !== '' : value !== undefined && value !== null
}

// Seconds until the client may try again under `name`, in this process's memory, or undefined while it is under the limit: for kay's own routes.
export function overLimit(name: string, client: string, max: number, windowMs: number): number | undefined {
  return waitFor(memoryOf(name).hit(limitKey(name, client), windowMs), max)
}

function memoryOf(name: string): ReturnType<typeof memoryRates> {
  let memory = memories.get(name)

  if (!memory)
    memories.set(name, memory = memoryRates())

  return memory
}

// Expired windows sit first, so dropping them, then the oldest live ones when still full, costs each new window what it removes.
function makeRoom(windows: Map<string, RateWindow>, now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt > now && windows.size < MAX_WINDOWS)
      return

    windows.delete(key)
  }
}

// One key per IPv6 /64, the block a single host or home network holds, so rotating through it buys no fresh window.
export function rateKey(address: string): string {
  if (!address.includes(':') || address.toLowerCase().startsWith('::ffff:'))
    return address

  const plain = address.replace(ZONE, '').toLowerCase()
  const [head = '', tail] = plain.split('::')
  const left: string[] = head === '' ? [] : head.split(':')
  const right: string[] = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups: string[] = tail === undefined ? left : [...left, ...Array.from<string>({ length: 8 - left.length - right.length }).fill('0'), ...right]

  return `${groups.slice(0, 4).map(group => group.replace(LEADING_ZEROS, '')).join(':')}::/64`
}

// Records the app's proxy settings on each request it gets, for `clientAddress` to read them wherever it is called from.
export function trustProxy(app: Elysia, proxy: ProxyConfig | undefined): void {
  if (proxy) {
    const { hops, header } = proxy

    if ((hops === undefined) === (header === undefined))
      throw new Error('kay: proxy takes either hops, the number of proxies in front, or header, the one a proxy sets to the client\'s address')

    if (hops !== undefined && (!Number.isInteger(hops) || hops < 1))
      throw new Error(`kay: proxy.hops is the number of proxies in front, a whole number from 1; got ${hops}`)

    if (header !== undefined && header.trim() === '')
      throw new Error('kay: proxy.header names the header a proxy sets to the client\'s address, such as cf-connecting-ip')
  }

  app.onRequest(({ request, server }) => {
    proxies.set(request, proxy ?? null)

    if (server)
      servers.set(request, server)
  })
}

// The socket's address, unless it is a proxy on this machine or network the app's `proxy` setting trusts: then the client's address as that proxy passed it on.
// `proxy` stands in for the app's setting, for a plain Elysia app that `pages()` does not serve.
export function clientAddress(request: Request, server: Server<unknown> | null | undefined, proxy?: ProxyConfig): string {
  const address = rewrittenAddress(request) ?? (server ?? servers.get(request))?.requestIP(request)?.address
  const trusted = proxy ?? proxies.get(request)
  // Under `app.handle()`, as in a test, there is no socket: the request came from whatever the test says.
  const fromProxy = address === undefined || LOOPBACK_OR_PRIVATE.test(address)

  if (trusted && fromProxy) {
    const forwarded = forwardedAddress(request, trusted)

    if (forwarded !== undefined && forwarded !== '')
      return forwarded
  }

  if (!trusted && address !== undefined && fromProxy && request.headers.has('x-forwarded-for'))
    warnUnconfigured()

  return address ?? 'unknown'
}

// Each proxy appends the address it was reached from to `X-Forwarded-For`, so the client is `hops` entries from the end; with fewer, the request skipped an outer proxy and the first entry is who reached the inner one.
function forwardedAddress(request: Request, { hops = 1, header }: ProxyConfig): string | undefined {
  if (header !== undefined) {
    const value = request.headers.get(header)?.trim()

    return value === '' ? undefined : value
  }

  const entries = request.headers.get('x-forwarded-for')?.split(',').map(entry => entry.trim()).filter(entry => entry !== '') ?? []

  return entries[Math.max(0, entries.length - hops)]
}

// The id of a request, on its log lines and its `X-Request-Id` header: the one a proxy the app's `proxy` setting trusts passed on, else one made for it, time-ordered.
export function requestId(request: Request): string {
  let id = requestIds.get(request)

  if (id === undefined) {
    id = passedId(request) ?? Bun.randomUUIDv7('base64url')
    requestIds.set(request, id)
  }

  return id
}

// The id a request kay rewrote had before, as the request served in its place is another.
export function keepRequestId(request: Request, id: string): void {
  requestIds.set(request, id)
}

function passedId(request: Request): string | undefined {
  const id = request.headers.get('x-request-id')

  if (id === null || !proxies.get(request) || !PASSED_ID.test(id))
    return undefined

  const address = rewrittenAddress(request) ?? servers.get(request)?.requestIP(request)?.address

  return address === undefined || LOOPBACK_OR_PRIVATE.test(address) ? id : undefined
}

function warnUnconfigured(): void {
  if (warnedUnconfigured)
    return

  warnedUnconfigured = true
  console.warn('kay: requests come through a proxy, as their X-Forwarded-For shows, but kay.config.ts sets no proxy, so rate limits count every visitor as the proxy; set proxy: { hops: 1 } for one proxy such as nginx, or proxy: { header } for the header a proxy sets to the client\'s address')
}
