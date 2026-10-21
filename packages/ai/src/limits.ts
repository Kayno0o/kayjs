import type { Duration, RateStore } from 'kay'
import type { AiLimit } from './errors'
import type { Piece, Usage } from './types'
import process from 'node:process'
import { logFrom } from 'kay'
import { configError, durationSeconds, keyedDigest, userOf } from 'kay/library'
import { clientAddress, memoryRates, rateKey } from 'kay/server'
import { AiError } from './errors'

const TOTAL = 'ai:budget\ntotal'
const SLOT = Symbol.for('kayjs-ai.limits')
const CHARS_PER_TOKEN = 4
const log = logFrom('kayjs-ai')
// What a production app gets when it sets neither: a public chat is paid for by whoever runs it, so it is never unlimited by omission. `false` opts out.
const DEFAULT_LIMIT: LimitOptions = { max: 20, window: '10m' }
const DEFAULT_BUDGET: BudgetOptions = { tokens: 100_000, window: '1d' }
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
  // In production 20 asks per visitor every 10 minutes unless set; `false` lifts it.
  rateLimit?: LimitOptions | false | undefined
  // In production 100,000 tokens per visitor every day unless set, with no total; `false` lifts it.
  budget?: BudgetOptions | false | undefined
  // Who a signed-in visitor is, such as their id: counted in place of their address, and in place of the user a library such as kayjs-auth names. Left out, that user counts, else the address.
  key?: ((request: Request) => string | undefined | Promise<string | undefined>) | undefined
  // The old name of `rateLimit`, taken until 1.73: where both are given, `rateLimit` wins.
  limit?: LimitOptions | false | undefined
  // The old name of `key`, taken until 1.73.
  visitor?: ((request: Request) => string | undefined | Promise<string | undefined>) | undefined
}

interface Counter {
  ms: number
  store: RateStore
}

interface Settings {
  limit: (Counter & { max: number }) | undefined
  budget: (Counter & { tokens: number, total: number | undefined }) | undefined
  key: AiOptions['key']
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

  if (!holder[SLOT]) {
    const memories = new Map<string, RateStore>()

    holder[SLOT] = { settings: settingsOf({}, memories), memories, held: new Map() }
  }

  return holder[SLOT]
}

function memoryFor(memories: Map<string, RateStore>, name: string): RateStore {
  let store = memories.get(name)

  if (!store)
    memories.set(name, store = memoryRates())

  return store
}

function wholeNumber(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < 1)
    throw configError(what, value, 'a whole number of at least 1')

  return value as number
}

// The settings an app's options give, the production defaults filling what it left out.
function settingsOf({ rateLimit, limit: oldLimit, budget, key, visitor }: AiOptions, memories: Map<string, RateStore>): Settings {
  const settings: Settings = { limit: undefined, budget: undefined, key: key ?? visitor }
  const limit = rateLimit ?? oldLimit
  const production = process.env.NODE_ENV === 'production'
  const chosenLimit = limit ?? (production ? DEFAULT_LIMIT : undefined)
  const chosenBudget = budget ?? (production ? DEFAULT_BUDGET : undefined)

  if (chosenLimit !== undefined && chosenLimit !== false)
    settings.limit = { max: wholeNumber(chosenLimit.max, 'ai({ rateLimit }).max'), ms: durationSeconds(chosenLimit.window, 'ai({ rateLimit }).window') * 1000, store: chosenLimit.store ?? memoryFor(memories, 'limit') }

  if (chosenBudget !== undefined && chosenBudget !== false) {
    if (chosenBudget.store !== undefined && chosenBudget.store.peek === undefined)
      throw configError('ai({ budget }).store has no peek(key), which the budget reads before an ask without counting it; add it or use memoryRates() or sqliteRates()')

    settings.budget = {
      tokens: wholeNumber(chosenBudget.tokens, 'ai({ budget }).tokens'),
      total: chosenBudget.total === undefined ? undefined : wholeNumber(chosenBudget.total, 'ai({ budget }).total'),
      ms: durationSeconds(chosenBudget.window, 'ai({ budget }).window') * 1000,
      store: chosenBudget.store ?? memoryFor(memories, 'budget'),
    }
  }

  return settings
}

// Called by `ai()`, which the app's config runs again on every reload: the settings are replaced, the memory counts kept.
export function configureLimits(options: AiOptions): void {
  slot().settings = settingsOf(options, slot().memories)
}

// The limit and budget `ai()` set, as the dev tool shows them; null where there is none.
export function limitsInEffect(): { limit: { max: number, seconds: number } | null, budget: { tokens: number, total: number | null, seconds: number } | null } {
  const { limit, budget } = slot().settings

  return {
    limit: limit ? { max: limit.max, seconds: limit.ms / 1000 } : null,
    budget: budget ? { tokens: budget.tokens, total: budget.total ?? null, seconds: budget.ms / 1000 } : null,
  }
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

async function visitorKey(keyOf: Settings['key'], { request, visitor: named }: Asker): Promise<string | undefined> {
  let user = named

  if ((user === undefined || user === '') && request) {
    const hooked = await keyOf?.(request)

    user = typeof hooked === 'string' && hooked !== '' ? hooked : await userOf(request)
  }

  if (typeof user === 'string' && user !== '')
    return `user:${hashed(user)}`

  return request ? `address:${hashed(rateKey(clientAddress(request, undefined)))}` : undefined
}

// A store shared by processes, a database say, then holds no address nor user id, only a digest keyed by the app's secret to count under.
export function hashed(text: string): string {
  return keyedDigest('ai-visitor', text)
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
    const key = await visitorKey(settings.key, asker)

    if (limit && key !== undefined) {
      const window = checked(await bounded(async () => limit.store.hit(`ai:limit\n${key}`, `${limit.ms}ms`)))!

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
      key === undefined ? undefined : budget.store.hit(`ai:budget\n${key}`, `${budget.ms}ms`, used),
      budget.total === undefined ? undefined : budget.store.hit(TOTAL, `${budget.ms}ms`, used),
    ]))

    if (windows.some(window => window !== undefined && window.count < used))
      log.error(`the budget's store counted less than the ${used} tokens of a reply; its hit(key, window, weight) must add weight to the count`)
  }
  catch (error) {
    log.error(`${used} tokens could not be counted against the budget`, error)
  }
}

// The tokens a reply used: the provider's counts, else an estimate from the characters. Nothing at all when nothing came back from a failure, which billed nothing; a reply stopped before anything came still counts its input, as the provider may be reading it.
export function tokensUsed(usage: Partial<Usage>, sent: number, received: number, stopped: boolean): number {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && received === 0 && !stopped)
    return 0

  // Every token counts as one, cached reads and cache writes included, so the budget stays a cap on tokens and not a price; weighing them by price would change this line alone.
  const cached = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

  return (usage.inputTokens ?? Math.ceil(sent / CHARS_PER_TOKEN)) + cached + (usage.outputTokens ?? Math.ceil(received / CHARS_PER_TOKEN))
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
