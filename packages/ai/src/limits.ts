import type { Duration, RateStore } from 'kay'
import type { AiLimit } from './errors'
import type { Piece, Usage } from './types'
import { logFrom } from 'kay'
import { durationSeconds, userOf } from 'kay/library'
import { clientAddress, memoryRates, rateKey } from 'kay/server'
import { AiError } from './errors'

const TOTAL = 'ai:budget\ntotal'
const SLOT = Symbol.for('kayjs-ai.limits')
const CHARS_PER_TOKEN = 4
const log = logFrom('kayjs-ai')
// How long a store may take to answer before the ask is refused as `unavailable`, or the count given up on.
let storeTimeoutMs = 5000

// How many asks a visitor makes in a window.
export interface LimitOptions {
  max: number
  window: Duration
  // In this process's memory unless given: `sqliteRates(path)` or a store of the app's own keeps the count over a restart and shares it between processes.
  store?: RateStore | undefined
}

// How many tokens, input and output, the replies to a visitor may use in a window, and to all visitors with `total`.
export interface BudgetOptions {
  tokens: number
  total?: number | undefined
  window: Duration
  // As the limit's, and it must tell a window's count without adding to it (`peek`), as `memoryRates` and `sqliteRates` do.
  store?: RateStore | undefined
}

export interface AiOptions {
  limit?: LimitOptions | undefined
  budget?: BudgetOptions | undefined
  // Who a signed-in visitor is, such as their id: counted in place of their address, and in place of the user a library such as kayjs-auth names. Left out, that user counts, else the address.
  visitor?: ((request: Request) => string | undefined | Promise<string | undefined>) | undefined
}

interface Counter {
  ms: number
  store: RateStore
}

interface Settings {
  limit: (Counter & { max: number }) | undefined
  budget: (Counter & { tokens: number, total: number | undefined }) | undefined
  visitor: AiOptions['visitor']
}

// Who an ask is for, worked out when its reply is first read.
export interface Asker {
  request: Request | undefined
  visitor: string | undefined
  // The characters sent, which stand for the input tokens when the provider counts none.
  chars: number
  // The most output tokens the reply may use, which the budget holds for it while it runs.
  maxTokens: number
}

// Read off the global, so every copy of the library in the process shares the app's settings and its counts.
interface Slot {
  settings: Settings
  memories: Map<string, RateStore>
  // The tokens held by the replies running in this process, by the key of the budget they count against.
  held: Map<string, number>
}

// Releases nothing: the hold of an ask that holds none.
function nothing(): void {
  return undefined
}

function slot(): Slot {
  const holder = globalThis as { [SLOT]?: Slot }

  return holder[SLOT] ??= { settings: { limit: undefined, budget: undefined, visitor: undefined }, memories: new Map(), held: new Map() }
}

function memoryFor(name: string): RateStore {
  const { memories } = slot()
  let store = memories.get(name)

  if (!store)
    memories.set(name, store = memoryRates())

  return store
}

function wholeNumber(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1)
    throw new TypeError(`kayjs-ai: ${what} is ${String(value)}; it takes a whole number of at least 1`)

  return value as number
}

// Called by `ai()`, which the app's config runs again on every reload: the settings are replaced, the memory counts kept.
export function configureLimits({ limit, budget, visitor }: AiOptions): void {
  const settings: Settings = { limit: undefined, budget: undefined, visitor }

  if (limit)
    settings.limit = { max: wholeNumber(limit.max, 'ai({ limit }).max'), ms: durationSeconds(limit.window, 'ai({ limit }).window', 'kayjs-ai') * 1000, store: limit.store ?? memoryFor('limit') }

  if (budget) {
    if (budget.store !== undefined && budget.store.peek === undefined)
      throw new TypeError('kayjs-ai: ai({ budget }).store has no peek(key), which the budget reads before an ask without counting it; add it or use memoryRates() or sqliteRates()')

    settings.budget = {
      tokens: wholeNumber(budget.tokens, 'ai({ budget }).tokens'),
      total: budget.total === undefined ? undefined : wholeNumber(budget.total, 'ai({ budget }).total'),
      ms: durationSeconds(budget.window, 'ai({ budget }).window', 'kayjs-ai') * 1000,
      store: budget.store ?? memoryFor('budget'),
    }
  }

  slot().settings = settings
}

// Forgets the counts kept in memory: for a test.
export function forgetCounts(): void {
  slot().memories.clear()
  slot().held.clear()
}

// Shortens the time a store may take, for a test.
export function storeTimeout(ms: number): void {
  storeTimeoutMs = ms
}

// What a store answers, or a refusal to wait for it: a store over the network that hangs must not hang the chat.
async function bounded<T>(read: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      (async () => read())(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the store did not answer in ${storeTimeoutMs} ms`)), storeTimeoutMs)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

async function visitorKey(visitor: Settings['visitor'], { request, visitor: named }: Asker): Promise<string | undefined> {
  let user = named

  if ((user === undefined || user === '') && request) {
    const hooked = await visitor?.(request)

    user = typeof hooked === 'string' && hooked !== '' ? hooked : await userOf(request)
  }

  if (typeof user === 'string' && user !== '')
    return `user:${user}`

  return request ? `address:${rateKey(clientAddress(request, undefined))}` : undefined
}

function seconds(resetAt: number): number {
  return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
}

function checked(window: { count: number, resetAt: number } | undefined): { count: number, resetAt: number } | undefined {
  if (window !== undefined && (!Number.isFinite(window.count) || !Number.isFinite(window.resetAt)))
    throw new TypeError('the store answered something that is no window')

  return window
}

const REASONS: Record<AiLimit, string> = {
  asks: 'this visitor asked too often',
  budget: 'this visitor used up the token budget',
  total: 'the token budget of all visitors is used up',
}

function limited(limit: AiLimit, resetAt: number): AiError {
  const retryAfter = seconds(resetAt)

  return new AiError('limited', `${REASONS[limit]}; retry in ${retryAfter} s`, { retryAfter, limit })
}

// Counts the ask against the limit and refuses it past the limit or when the budget, with what the replies running hold of it, is used up; returns the key the tokens are counted under and what releases the hold.
// The budget is compared and held in one step, after the store was read, so asks started together see each other's holds. A store that fails or hangs refuses too: a public chat must not run unlimited because its limit could not be read.
async function admit(settings: Settings, asker: Asker): Promise<{ key: string | undefined, release: () => void }> {
  const { limit, budget } = settings
  const { held } = slot()

  try {
    const key = await visitorKey(settings.visitor, asker)

    if (limit && key !== undefined) {
      const window = checked(await bounded(async () => limit.store.hit(`ai:limit\n${key}`, limit.ms)))!

      if (window.count > limit.max)
        throw limited('asks', window.resetAt)
    }

    if (!budget)
      return { key, release: nothing }

    const name = key === undefined ? undefined : `ai:budget\n${key}`
    const visitor = name === undefined ? undefined : checked(await bounded(async () => budget.store.peek!(name)))
    const total = budget.total === undefined ? undefined : checked(await bounded(async () => budget.store.peek!(TOTAL)))

    // No await from here to the hold.
    if (name !== undefined && (visitor?.count ?? 0) + (held.get(name) ?? 0) >= budget.tokens)
      throw limited('budget', visitor?.resetAt ?? Date.now() + 1000)

    if (budget.total !== undefined && (total?.count ?? 0) + (held.get(TOTAL) ?? 0) >= budget.total)
      throw limited('total', total?.resetAt ?? Date.now() + 1000)

    return { key, release: hold([...name === undefined ? [] : [name], ...budget.total === undefined ? [] : [TOTAL]], Math.ceil(asker.chars / CHARS_PER_TOKEN) + asker.maxTokens) }
  }
  catch (error) {
    if (error instanceof AiError)
      throw error

    throw new AiError('unavailable', `the limit could not be checked: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

// Holds the most a reply may use against the budget while it runs, so asks started together do not all pass a check none of them has counted into yet. Returns what releases it.
function hold(names: string[], tokens: number): () => void {
  const { held } = slot()

  for (const name of names)
    held.set(name, (held.get(name) ?? 0) + tokens)

  return () => {
    for (const name of names) {
      const left = (held.get(name) ?? 0) - tokens

      if (left > 0)
        held.set(name, left)
      else
        held.delete(name)
    }
  }
}

// Adds the tokens a reply used to the visitor's budget and the total. The reply was given, so a store failing or hanging here is logged, not thrown.
async function record(budget: NonNullable<Settings['budget']>, key: string | undefined, used: number): Promise<void> {
  try {
    const windows = await bounded(async () => Promise.all([
      key === undefined ? undefined : budget.store.hit(`ai:budget\n${key}`, budget.ms, used),
      budget.total === undefined ? undefined : budget.store.hit(TOTAL, budget.ms, used),
    ]))

    if (windows.some(window => window !== undefined && window.count < used))
      log.error(`the budget's store counted less than the ${used} tokens of a reply; its hit(key, windowMs, weight) must add weight to the count`)
  }
  catch (error) {
    log.error(`${used} tokens could not be counted against the budget`, error)
  }
}

// The tokens a reply used: the provider's counts, else an estimate from the characters. Nothing at all when nothing came back from a failure, which billed nothing; a reply stopped before anything came still counts its input, as the provider may be reading it.
function tokensUsed(usage: Partial<Usage>, sent: number, received: number, stopped: boolean): number {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && received === 0 && !stopped)
    return 0

  return (usage.inputTokens ?? Math.ceil(sent / CHARS_PER_TOKEN)) + (usage.outputTokens ?? Math.ceil(received / CHARS_PER_TOKEN))
}

// The pieces `open` yields, once the settings of `ai()` let the ask through and until the reply ends, when its tokens are counted whether it finished, failed or was stopped.
export async function* guarded(open: () => AsyncIterable<Piece>, asker: Asker, signal: AbortSignal): AsyncGenerator<Piece> {
  const { settings } = slot()

  if (!settings.limit && !settings.budget) {
    yield* open()

    return
  }

  // Stopped before it began: the provider is never called, so nothing is asked or counted.
  if (signal.aborted)
    return

  const { key, release } = await admit(settings, asker)
  const usage: Partial<Usage> = {}
  let received = 0

  try {
    for await (const piece of open()) {
      if ('text' in piece)
        received += piece.text.length
      else if ('usage' in piece)
        Object.assign(usage, piece.usage)

      yield piece
    }
  }
  finally {
    const used = tokensUsed(usage, asker.chars, received, signal.aborted)

    try {
      if (settings.budget && used > 0)
        await record(settings.budget, key, used)
    }
    finally {
      release()
    }
  }
}
