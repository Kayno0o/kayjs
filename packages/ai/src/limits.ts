import type { Duration, RateStore } from 'kay'
import type { AiLimit } from './errors'
import type { Piece, Usage } from './types'
import { logFrom } from 'kay'
import { durationSeconds } from 'kay/library'
import { clientAddress, memoryRates, rateKey } from 'kay/server'
import { AiError } from './errors'

const SLOT = Symbol.for('kayjs-ai.limits')
const CHARS_PER_TOKEN = 4
const log = logFrom('kayjs-ai')

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
  // Who a signed-in visitor is, such as their id: counted in place of their address. Left out, the address counts.
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
}

// Read off the global, so every copy of the library in the process shares the app's settings and its counts.
interface Slot {
  settings: Settings
  memories: Map<string, RateStore>
}

function slot(): Slot {
  const holder = globalThis as { [SLOT]?: Slot }

  return holder[SLOT] ??= { settings: { limit: undefined, budget: undefined, visitor: undefined }, memories: new Map() }
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
}

async function visitorKey(visitor: Settings['visitor'], { request, visitor: named }: Asker): Promise<string | undefined> {
  const user = named ?? (request && await visitor?.(request))

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

// Counts the ask against the limit and refuses it past the limit or when the budget is used up; returns the key the tokens are counted under.
// A store that fails refuses too: a public chat must not run unlimited because its limit could not be read.
async function admit(settings: Settings, asker: Asker): Promise<string | undefined> {
  const { limit, budget } = settings

  try {
    const key = await visitorKey(settings.visitor, asker)

    if (limit && key !== undefined) {
      const window = checked(await limit.store.hit(`ai:limit\n${key}`, limit.ms))!

      if (window.count > limit.max)
        throw limited('asks', window.resetAt)
    }

    if (budget) {
      const visitor = key === undefined ? undefined : checked(await budget.store.peek!(`ai:budget\n${key}`))

      if (visitor && visitor.count >= budget.tokens)
        throw limited('budget', visitor.resetAt)

      const total = budget.total === undefined ? undefined : checked(await budget.store.peek!('ai:budget\ntotal'))

      if (total && total.count >= budget.total!)
        throw limited('total', total.resetAt)
    }

    return key
  }
  catch (error) {
    if (error instanceof AiError)
      throw error

    throw new AiError('unavailable', `the limit could not be checked: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

// Adds the tokens a reply used to the visitor's budget and the total. The reply was given, so a store failing here is logged, not thrown.
async function record(budget: NonNullable<Settings['budget']>, key: string | undefined, used: number): Promise<void> {
  try {
    if (key !== undefined)
      await budget.store.hit(`ai:budget\n${key}`, budget.ms, used)

    if (budget.total !== undefined)
      await budget.store.hit('ai:budget\ntotal', budget.ms, used)
  }
  catch (error) {
    log.error(`${used} tokens could not be counted against the budget`, error)
  }
}

// The tokens a reply used: the provider's counts, else an estimate from the characters. Nothing at all when nothing came back, as a failure before the provider answered billed nothing.
function tokensUsed(usage: Partial<Usage>, sent: number, received: number): number {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined && received === 0)
    return 0

  return (usage.inputTokens ?? Math.ceil(sent / CHARS_PER_TOKEN)) + (usage.outputTokens ?? Math.ceil(received / CHARS_PER_TOKEN))
}

// The pieces `open` yields, once the settings of `ai()` let the ask through and until the reply ends, when its tokens are counted whether it finished, failed or was stopped.
export async function* guarded(open: () => AsyncIterable<Piece>, asker: Asker): AsyncGenerator<Piece> {
  const { settings } = slot()

  if (!settings.limit && !settings.budget) {
    yield* open()

    return
  }

  const key = await admit(settings, asker)
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
    const used = tokensUsed(usage, asker.chars, received)

    if (settings.budget && used > 0)
      await record(settings.budget, key, used)
  }
}
