import type { Server } from 'bun'
import type { Elysia, TSchema } from 'elysia'
import type { BlockList } from 'node:net'
import type { ProxyConfig } from '../config'
import type { ActionRateLimit, RateKey, RateKeyContext, RateLimit, RateStore, RateWindow, ServerAction } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { honeypotField, minTimeOf, STAMP_FIELD } from '../runtime/action'
import { durationSeconds, legacyMs } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { openSqlite } from '../runtime/sqlite.server'
import { NAVIGATE_HEADER, WORK_HEADER } from '../runtime/swap'
import { appStore } from './app-store'
import { nodeNet } from './builtins'
import { checkRequestIdHeader } from './config-limits'
import { onReload } from './reload'
import { rewrittenAddress } from './rewrite'
import { sharedKey, stampTime } from './stamp'
import { kayWord } from './words'
import { proofOfWork, signWork, workRefusal } from './work'

export interface ProtectionRefusal {
  status: number
  // The field the message is for, `''` for the form as a whole.
  field: string
  message: string
  headers?: Record<string, string>
}

export interface RateLimiter {
  // Counts an attempt from the request's client, or under the app's own key such as an account id: the seconds it must wait before the next one once over the limit, else undefined. `server` is the one serving the request, read from `pages()`'s app when left out.
  // `weight` counts that many at once, the tokens a reply used say, against a `max` of tokens.
  hit: (from: Request | string, server?: Server<unknown> | null, weight?: number) => Promise<number | undefined>
}

// A post a honeypot caught, answered as if it went through.
export const PRETEND = 'pretend'

// The most windows a memory store keeps: past it, a new client makes room by dropping the expired windows, then the oldest ones.
const MAX_WINDOWS = 10_000
// How often the SQLite store sweeps the windows that closed.
const SWEEP_MS = 60_000
const ZONE = /%.*$/
// An HTTP header name: the token characters.
const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/
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
// The proxy settings already warned about a forwarded header from a public peer, once each, by what they say: plain Elysia may pass a fresh object per request.
const warnedUntrusted = new Set<string>()
// Each list of `trusted` ranges, read once.
const trustedRanges = new Map<string, BlockList>()
const RANGE = /^([^/]+)\/(\d{1,3})$/
const requestIds = new WeakMap<Request, string>()

// The header a request's id comes in from a trusted proxy and goes out on, every context holding it; `requestIdHeader` in kay.config.ts renames it.
// It is one name per process, as the helpers that put it on a response see no app: an app that sets none leaves a name another one set, and two apps naming different ones is refused.
const DEFAULT_ID_HEADER = 'x-request-id'
let idHeader = DEFAULT_ID_HEADER

export function requestIdHeader(): string {
  return idHeader
}

// Forgets the name set, for tests that boot apps naming different headers in one process.
export function resetRequestIdHeader(): void {
  idHeader = DEFAULT_ID_HEADER
}

export function setRequestIdHeader(name: string | undefined): void {
  checkRequestIdHeader(name)

  if (name === undefined)
    return

  if (idHeader !== DEFAULT_ID_HEADER && idHeader !== name.toLowerCase())
    throw new KayError('config-invalid', `kay: requestIdHeader is ${name}, but another app in this process already names ${idHeader}; a process uses one name`)

  idHeader = name.toLowerCase()
}

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

// The window as the stores read it.
function windowText(rateLimit: { window: Duration }): `${number}ms` {
  return `${windowMs(rateLimit)}ms`
}

// Fixed windows per key in this process: enough to slow a script hammering a form, which is what a contact or login form needs.
export function memoryRates(): { hit: (key: string, window: Duration, weight?: number) => RateWindow, peek: (key: string) => RateWindow | undefined } {
  // Ordered by when each window opened, so the oldest come first.
  const windows = new Map<string, RateWindow>()

  return {
    peek(key) {
      const window = windows.get(key)

      return window && window.resetAt > Date.now() ? { ...window } : undefined
    },
    hit(key, length, weight = 1) {
      const now = Date.now()
      let window = windows.get(key)

      if (!window || window.resetAt <= now) {
        if (!window)
          makeRoom(windows, now)

        // Moved to the end, as the newest window.
        windows.delete(key)
        windows.set(key, window = { count: 0, resetAt: now + legacyMs(length, 'a rate window') })
      }

      window.count += weight

      return { count: window.count, resetAt: window.resetAt }
    },
  }
}

const RATES_KEY_BYTES = 32

// The random key every process opening `path` shares when no secret is set: created once beside the file, race-free, and never written into the store itself.
function ratesKeyFile(path: string): Buffer {
  if (path === ':memory:' || path === '')
    return Buffer.from(crypto.getRandomValues(new Uint8Array(RATES_KEY_BYTES)))

  const file = `${path}.key`
  const read = () => {
    try {
      const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url')

      return key.length === RATES_KEY_BYTES ? key : undefined
    }
    catch (error) {
      // A file another user owns is no key to replace silently.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error

      return undefined
    }
  }
  const existing = read()

  if (existing)
    return existing

  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(RATES_KEY_BYTES)))
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}`

  try {
    writeFileSync(temp, key.toString('base64url'), { mode: 0o600 })
    // A hard link fails when another process won the race, where a rename would replace its key.
    linkSync(temp, file)

    return key
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error

    // A file holding no key is replaced; one another process just made is read.
    const won = read()

    if (won)
      return won

    kayLog('warn', `${file} held no rate-limit key and was replaced`)
    renameSync(temp, file)

    return key
  }
  finally {
    rmSync(temp, { force: true })
  }
}

// Windows kept in a SQLite file, so every process of the machine opening it counts the same attempts.
// A key is stored pseudonymised: an HMAC keyed by the session's, the app's or the preview's secret once one is set, else by a random key kept in a file beside the store (`<path>.key`, the server's user alone), so the store's file alone cannot be checked against a guessed address.
export function sqliteRates(path: string): SyncRates {
  let opened: OpenRates | undefined

  // A reload closes the file for the module that named the store, whichever module first used it; the module running again names a store of its own.
  onReload(() => opened?.close())

  // The file is opened by the first call, so loading a config that names it, to build or check, creates nothing.
  return {
    hit: (key, window, weight) => (opened ??= openRates(path)).hit(key, window, weight),
    peek: key => (opened ??= openRates(path)).peek(key),
  }
}

// Answered at once, as a store reading SQLite needs no promise.
export interface SyncRates { hit: (key: string, window: Duration, weight?: number) => RateWindow, peek: (key: string) => RateWindow | undefined }
type OpenRates = SyncRates & { close: () => void }

function openRates(path: string): OpenRates {
  const db = openSqlite(path)

  db.run('CREATE TABLE IF NOT EXISTS kay_rates (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)')
  // The sweep deletes by `reset_at`, so an index keeps it off a scan of every key.
  db.run('CREATE INDEX IF NOT EXISTS kay_rates_reset ON kay_rates (reset_at)')

  db.run('DROP TABLE IF EXISTS kay_rates_salt')

  // Read on the first key hashed without a secret, so an app with one never makes the file.
  let ownKey: Buffer | undefined
  const hashed = (key: string) => new Bun.CryptoHasher('sha256', sharedKey('rates') ?? (ownKey ??= ratesKeyFile(path))).update(key).digest('base64url')

  // The row's old values are what both cases read: a closed window opens afresh, an open one counts the weight more.
  const hit = db.query<{ count: number, reset_at: number }, [string, number, number, number]>('INSERT INTO kay_rates (key, count, reset_at) VALUES (?1, ?4, ?2 + ?3) ON CONFLICT (key) DO UPDATE SET count = CASE WHEN reset_at <= ?2 THEN ?4 ELSE count + ?4 END, reset_at = CASE WHEN reset_at <= ?2 THEN ?2 + ?3 ELSE reset_at END RETURNING count, reset_at')
  const peek = db.query<{ count: number, reset_at: number }, [string, number]>('SELECT count, reset_at FROM kay_rates WHERE key = ? AND reset_at > ?')
  const sweep = db.query('DELETE FROM kay_rates WHERE reset_at <= ?')
  let swept = 0

  return {
    close: () => db.close(),
    hit(key, window, weight = 1) {
      const now = Date.now()

      if (now - swept > SWEEP_MS) {
        swept = now
        sweep.run(now)
      }

      const row = hit.get(hashed(key), now, legacyMs(window, 'a rate window'), weight)!

      return { count: row.count, resetAt: row.reset_at }
    },
    peek(key) {
      const row = peek.get(hashed(key), Date.now())

      return row ? { count: row.count, resetAt: row.reset_at } : undefined
    },
  }
}

// A limit for a guard, an API route or a library, counted as an action's `rateLimit` is: `max` attempts from one client every `window`, under `name`, which limits sharing it count together.
export function rateLimit(name: string, limit: RateLimit): RateLimiter {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new KayError('config-invalid', `kay: rateLimit('${name}')'s max is ${limit.max}; it takes a whole number of at least 1`)

  const ms = durationSeconds(limit.window, `rateLimit('${name}')'s window`) * 1000

  return {
    hit: async (from, server, weight = 1) => {
      if (!Number.isSafeInteger(weight) || weight < 1)
        throw new KayError('config-invalid', `kay: rateLimit('${name}').hit()'s weight is ${weight}; it takes a whole number of at least 1`)

      const window = await (limit.store ?? sharedRates(name)).hit(typeof from === 'string' ? `${name}\nkey:${from}` : limitKey(name, clientAddress(from, server)), `${ms}ms`, weight)

      // A count below the weight holds less than this hit alone: the store counted one, which shows on a window's first hit.
      if (window.count < weight)
        throw new KayError('config-invalid', `kay: rateLimit('${name}')'s store ignores the weight of a hit; its hit(key, window, weight) adds weight to the count`)

      return waitFor(window, limit.max)
    },
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

// What an API module or route limits its requests by: `max` every `window` from one client, or from whatever `key` names.
export interface ApiRateLimit extends RateLimit {
  key?: RateKey | undefined
}

// The longest wait among the limits a request to an API route is over, counting it against each, or undefined while it is under all; under the key each gives, the client's address else.
export async function apiLimitWait(limits: { name: string, limit: ApiRateLimit }[], request: Request, server: Server<unknown> | null | undefined, context: () => Omit<RateKeyContext, 'client'>): Promise<number | undefined> {
  if (limits.length === 0)
    return undefined

  const client = clientAddress(request, server)
  let wait: number | undefined

  for (const { name, limit } of limits) {
    const own = waitFor(await (limit.store ?? sharedRates(name)).hit(await actionKey(name, limit, request, client, context), windowText(limit)), limit.max)

    if (own !== undefined && (wait === undefined || own > wait))
      wait = own
  }

  return wait
}

// Checks a limit declared on an API module or route, as `rateLimit()` checks its own.
export function checkApiLimit(name: string, limit: ApiRateLimit): void {
  if (!Number.isInteger(limit.max) || limit.max < 1)
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has a max of ${limit.max}; it takes a whole number of at least 1`)

  durationSeconds(limit.window, `the rateLimit window of ${name}`)

  if (limit.key !== undefined && typeof limit.key !== 'function')
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has a key that is not a function; it takes a function of the request returning the string to count under`)

  if (limit.store !== undefined && typeof limit.store?.hit !== 'function')
    throw new KayError('config-invalid', `kay: the rateLimit of ${name} has a store without a hit(key, window) method; give it a RateStore`)
}

// Seconds until the next attempt may go through, or undefined while under the limit.
function waitFor(window: { count: number, resetAt: number }, max: number): number | undefined {
  return window.count > max ? Math.ceil((window.resetAt - Date.now()) / 1000) : undefined
}

// The requests the MCP endpoint dispatched to an action for an agent, which no form was filled in for.
const agentCalls = new WeakSet<Request>()

export function markAgentCall(request: Request): void {
  agentCalls.add(request)
}

export function isAgentCall(request: Request): boolean {
  return agentCalls.has(request)
}

// The agent's calls that a guard refused with 401, which is the sign-in challenge; a 401 the called route answered is its own.
const challenges = new WeakSet<Request>()

export function markChallenge(request: Request): void {
  if (agentCalls.has(request))
    challenges.add(request)
}

export function wasChallenged(request: Request): boolean {
  return challenges.has(request)
}

// Why a post must not reach the handler, `PRETEND` for a bot to answer as if it went through, or undefined when it may.
// `form` is a post filled in as a form, `plain` one the browser sent itself, which a form posting to the action always sends with its stamp; a call from kay's script may come from an island's form, which renders none.
export interface RefusalInput {
  body: unknown
  form: boolean
  server: Server<unknown> | null | undefined
  plain?: boolean | undefined
  keyContext?: (() => Omit<RateKeyContext, 'client'>) | undefined
}

export async function protectionRefusal(action: ServerAction<TSchema, unknown>, request: Request, { body, form, server, plain = form, keyContext }: RefusalInput): Promise<ProtectionRefusal | typeof PRETEND | undefined> {
  const { honeypot, messages } = action.protection ?? {}
  const field = honeypotField(action.protection)
  const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}

  if (form && field !== undefined && filledIn(fields[field])) {
    if (typeof honeypot === 'object' && honeypot.pretend)
      return PRETEND

    return { status: 422, field, message: messages?.honeypot ?? kayWord('kay.protection.honeypot') }
  }

  const minTime = action.protection && minTimesOf(action.protection)

  // With `plain`, only a post the browser sends itself: not a call, nor the page swap's.
  const checked = minTime && (typeof action.protection?.minTime === 'object' && action.protection.minTime.plain === true ? plain && request.headers.get(NAVIGATE_HEADER) !== '1' : plain || fields[STAMP_FIELD] !== undefined)

  if (form && checked) {
    const time = stampTime(action.url, fields[STAMP_FIELD])
    const age = time === undefined ? undefined : Date.now() - time

    if (age === undefined || age < minTime.after || age > minTime.maxAge) {
      if (minTime.pretend)
        return PRETEND

      // A stamp missing or forged is most often a page from before a restart, which changed the key: expired too.
      const reason = age !== undefined && age < minTime.after ? 'early' : 'expired'
      const message = messages?.minTime ?? (refusal => kayWord(`kay.protection.minTime.${refusal}`))

      return { status: 422, field: '', message: typeof message === 'string' ? message : message(reason) }
    }
  }

  const work = proofOfWork(action)

  // A form posted without kay's script sends no solution, refused unless `minTime` let it through above, which then checks it alone; an agent's call has no script to solve one.
  if (work && !agentCalls.has(request) && !(plain && minTime && (request.headers.get(WORK_HEADER) ?? '') === '')) {
    const reason = await workRefusal(action.url, request.headers.get(WORK_HEADER), work.store ?? sharedRates(`${action.url}#work`))

    if (reason === 'wrong' && work.pretend)
      return PRETEND

    if (reason !== undefined) {
      const message = messages?.proofOfWork ?? (refusal => kayWord(`kay.protection.proofOfWork.${refusal}`))

      // The fresh challenge kay's script solves to send the post again.
      return { status: 422, field: '', message: typeof message === 'string' ? message : message(reason), headers: { [WORK_HEADER]: signWork(action.url, work.difficulty, work.maxAge) } }
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
    const store = limit.store ?? sharedRates(name)

    if (limit.count === 'succeeded' && !store.peek)
      throw new KayError('config-invalid', `kay: ${name} counts only the posts that went through, so its store needs a peek(key) method; the app's \`store.rates\` has none`)

    const key = await actionKey(name, limit, request, client, keyContext)
    // A limit on the posts that went through only reads its count here; the handler's success adds to it.
    const own = limit.count === 'succeeded' ? reached(await store.peek!(key), limit.max) : waitFor(await store.hit(key, windowText(limit)), limit.max)

    if (own !== undefined && (wait === undefined || own > wait))
      wait = own
  }

  if (wait === undefined)
    return undefined

  const message = messages?.rateLimit ?? (seconds => kayWord('kay.protection.rateLimit', { seconds }))

  return { status: 429, field: '', message: typeof message === 'string' ? message : message(wait), headers: { 'retry-after': String(wait) } }
}

// Counts a post whose handler went through against the action's limits on those, under the keys the refusal check counted it by.
export async function countSucceeded(action: ServerAction<TSchema, unknown>, request: Request, server: Server<unknown> | null | undefined): Promise<void> {
  const limits = actionLimits(action).filter(({ limit }) => limit.count === 'succeeded')

  if (limits.length === 0)
    return

  const client = clientAddress(request, server)

  for (const { name, limit } of limits)
    await (limit.store ?? sharedRates(name)).hit(await actionKey(name, limit, request, client, undefined), windowText(limit))
}

// The most characters of a custom key kept as it is, a longer one is hashed: a store keeps a key whole.
const MAX_KEY_LENGTH = 256
// The key each limit counted a request under, so the count after the handler follows the one before it, whatever the handler changed.
const countedKeys = new WeakMap<Request, Map<object, string>>()
const warnedKeys = new WeakSet<object>()

// What the limit counts the request under: its `key`'s text, else the client's address; an empty text, one that is not a text or a key that throws counts the address, so the limit stays.
async function actionKey(name: string, limit: { key?: RateKey | undefined }, request: Request, client: string, context: (() => Omit<RateKeyContext, 'client'>) | undefined): Promise<string> {
  let kept = countedKeys.get(request)
  const known = kept?.get(limit)

  if (known !== undefined)
    return known

  if (!limit.key || !context)
    return limitKey(name, client)

  let identity: string | undefined

  try {
    const given: unknown = await limit.key({ ...context(), client })

    identity = typeof given === 'string' && given !== '' ? given : undefined

    if (given !== undefined && identity === undefined && !warnedKeys.has(limit)) {
      warnedKeys.add(limit)
      kayLog('warn', `the rateLimit key of ${name} gave ${typeof given === 'string' ? 'an empty text' : typeof given}, where it takes a non-empty text or undefined: the client's address counts instead`)
    }
  }
  catch (error) {
    if (!warnedKeys.has(limit)) {
      warnedKeys.add(limit)
      kayLog('warn', `the rateLimit key of ${name} threw, so the client's address counts instead`, error)
    }
  }

  const counted = identity === undefined ? limitKey(name, client) : `${name}\nkey:${identity.length > MAX_KEY_LENGTH ? new Bun.CryptoHasher('sha256').update(identity).digest('base64url') : identity}`

  if (!kept)
    countedKeys.set(request, kept = new Map<object, string>())

  kept.set(limit, counted)

  return counted
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
  return waitFor(memoryOf(name).hit(limitKey(name, client), `${windowMs}ms`), max)
}

// The store a limit counts in when it names none: the app's `store.rates`, else this process's memory.
function sharedRates(name: string): RateStore {
  return appStore()?.rates ?? memoryOf(name)
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

// `true` is one proxy in front and a number that many, the short forms of `{ hops }`.
function proxyOf(setting: ProxyConfig | number | boolean | undefined): ProxyConfig | undefined {
  if (setting === false)
    return undefined

  if (setting === true)
    return { hops: 1 }

  return typeof setting === 'number' ? { hops: setting } : setting
}

// The server that received `request`, once the app read it.
export function requestServer(request: Request): Server<unknown> | undefined {
  return servers.get(request)
}

// Refuses a `proxy` setting that names no proxy, so the boot can before any build starts.
export function checkProxy(setting: ProxyConfig | number | boolean | undefined): ProxyConfig | undefined {
  const proxy = proxyOf(setting)

  if (!proxy)
    return undefined

  const { hops, header, key, open } = proxy

  if ((hops !== undefined && header !== undefined) || (hops === undefined && header === undefined && key === undefined))
    throw new KayError('config-invalid', 'kay: proxy takes either hops, the number of proxies in front, or header, the one a proxy sets to the client\'s address')

  if (key !== undefined && !HEADER_NAME.test(key))
    throw new KayError('config-invalid', 'kay: proxy.key names the header the proxy sends its shared key in, such as x-upstream-key')

  if (open !== undefined && (key === undefined || open.some(path => !path.startsWith('/') || path === '/')))
    throw new KayError('config-invalid', 'kay: proxy.open lists paths below / that need no key, such as /api/push, and goes with proxy.key')

  if (hops !== undefined && (!Number.isInteger(hops) || hops < 1))
    throw new KayError('config-invalid', `kay: proxy.hops is the number of proxies in front, a whole number from 1; got ${hops}`)

  if (header !== undefined && header.trim() === '')
    throw new KayError('config-invalid', 'kay: proxy.header names the header a proxy sets to the client\'s address, such as cf-connecting-ip')

  rangesOf(proxy)

  return key === undefined || hops !== undefined || header !== undefined ? proxy : { ...proxy, hops: 1 }
}

// Records the app's proxy settings on each request it gets, for `clientAddress` to read them wherever it is called from.
export function trustProxy(app: Elysia, setting: ProxyConfig | number | boolean | undefined): void {
  const proxy = checkProxy(setting)

  app.onRequest(({ request, server }) => {
    proxies.set(request, proxy ?? null)

    if (server)
      servers.set(request, server)
  })
}

// The socket's address, unless it is a proxy on this machine or network the app's `proxy` setting trusts: then the client's address as that proxy passed it on.
// `proxy` stands in for the app's setting, for a plain Elysia app that `pages()` does not serve.
export function clientAddress(request: Request, server: Server<unknown> | null | undefined, setting?: ProxyConfig | number | boolean): string {
  const proxy = proxyOf(setting)
  const address = rewrittenAddress(request) ?? (server ?? servers.get(request))?.requestIP(request)?.address
  const trusted = proxy ?? proxies.get(request)
  // Under `app.handle()`, as in a test, there is no socket: the request came from whatever the test says.
  const fromProxy = address === undefined || fromTrusted(address, trusted)

  if (trusted && fromProxy) {
    const forwarded = forwardedAddress(request, trusted)

    if (forwarded !== undefined && forwarded !== '')
      return forwarded
  }

  if (!trusted && address !== undefined && fromProxy && request.headers.has('x-forwarded-for'))
    warnUnconfigured()

  if (trusted && !fromProxy && request.headers.has(trusted.header ?? 'x-forwarded-for'))
    warnUntrusted(trusted, address)

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
  const id = request.headers.get(idHeader)

  if (id === null || !proxies.get(request) || !PASSED_ID.test(id))
    return undefined

  const address = rewrittenAddress(request) ?? servers.get(request)?.requestIP(request)?.address

  return address === undefined || fromTrusted(address, proxies.get(request) ?? undefined) ? id : undefined
}

// This machine, a private network, or a range the setting trusts.
function fromTrusted(address: string, proxy: ProxyConfig | null | undefined): boolean {
  if (LOOPBACK_OR_PRIVATE.test(address))
    return true

  const ranges = proxy ? rangesOf(proxy) : undefined

  if (ranges === undefined)
    return false

  const family = familyOf(address)

  return family !== undefined && ranges.check(address, family.name)
}

function rangesOf(proxy: ProxyConfig): BlockList | undefined {
  if (!proxy.trusted)
    return undefined

  const key = proxy.trusted.join(',')
  let ranges = trustedRanges.get(key)

  if (!ranges) {
    ranges = new (nodeNet().BlockList)()

    for (const range of proxy.trusted as unknown[]) {
      const [, address = '', bits] = typeof range === 'string' ? RANGE.exec(range.trim()) ?? [range, range.trim()] : []
      const family = familyOf(address)
      const prefix = bits === undefined ? family?.bits : Number(bits)

      if (family === undefined || prefix === undefined || prefix > family.bits)
        throw new KayError('config-invalid', `kay: proxy.trusted takes address ranges such as 173.245.48.0/20 or 2400:cb00::/32; got ${JSON.stringify(range)}`)

      ranges.addSubnet(address, prefix, family.name)
    }

    trustedRanges.set(key, ranges)
  }

  return ranges
}

// An address's family as `BlockList` names it, and how many bits it has; none for anything but an address.
function familyOf(address: string): { name: 'ipv4' | 'ipv6', bits: number } | undefined {
  const family = nodeNet().isIP(address)

  if (family === 0)
    return undefined

  return family === 4 ? { name: 'ipv4', bits: 32 } : { name: 'ipv6', bits: 128 }
}

function warnUntrusted(proxy: ProxyConfig, address: string): void {
  const header = proxy.header ?? 'X-Forwarded-For'
  const key = `${header} ${proxy.trusted?.join(',') ?? ''}`

  if (warnedUntrusted.has(key))
    return

  warnedUntrusted.add(key)

  kayLog('warn', `a request from ${address} carries ${header}, but that address is public and not in proxy.trusted, so kay counts it as the client and ignores the header; a CDN reaching the server from public addresses has its ranges listed in proxy.trusted`)
}

function warnUnconfigured(): void {
  if (warnedUnconfigured)
    return

  warnedUnconfigured = true
  kayLog('warn', 'requests come through a proxy, as their X-Forwarded-For shows, but kay.config.ts sets no proxy, so rate limits count every visitor as the proxy; set proxy: { hops: 1 } for one proxy such as nginx, or proxy: { header } for the header a proxy sets to the client\'s address')
}
