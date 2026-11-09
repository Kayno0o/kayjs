import type { AiErrorKind } from './errors'
import type { Hooks } from './hooks'
import type { Streams } from './loop'
import type { FallbackModel, Inner, Provider, ProviderMessage, ProviderRequest, Resilience, RetryOptions, Step } from './types'
import { sleep } from '@kaynooo/utils'
import { configError, durationSeconds } from 'kay/library'
import { given } from './config'
import { AiError } from './errors'
import { answersAsFake } from './fake'
import { tell } from './hooks'
import { named } from './models'

const SLOT = Symbol.for('kayjs-ai.resilience')
// What a provider says when it is down, busy or slow: asking again or elsewhere may help, which a refused key or request never does.
const TRANSIENT = new Set<AiErrorKind>(['unavailable', 'rate-limited', 'timeout', 'network'])
const DEFAULT_ATTEMPTS = 2
const DEFAULT_BACKOFF = '500ms'
const DEFAULT_MAX_WAIT = '10s'
const MAX_ATTEMPTS = 10
// A wait is shortened by up to this share at random.
const JITTER = 0.5

interface Policy {
  attempts: number
  backoff: number
  maxWait: number
}

interface Target {
  provider: Provider
  model: string
}

// The retry and fallback `ai()` set, on the global so every copy of the library in the process shares them.
function slot(): Resilience {
  return (globalThis as { [SLOT]?: Resilience })[SLOT] ?? {}
}

function milliseconds(value: unknown, what: string): number {
  return Math.ceil(durationSeconds(value, what) * 1000)
}

function policyOf(retry: RetryOptions, what: string): Policy {
  if (typeof retry !== 'object' || retry === null || Array.isArray(retry))
    throw configError('ai', 'retry', `${what} is false or { attempts?, backoff?, maxWait? }`)

  const attempts = retry.attempts ?? DEFAULT_ATTEMPTS

  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS)
    throw configError('ai', 'retry', `${what}.attempts is a whole number from 1 to ${MAX_ATTEMPTS}`)

  return { attempts, backoff: milliseconds(retry.backoff ?? DEFAULT_BACKOFF, `${what}.backoff`), maxWait: milliseconds(retry.maxWait ?? DEFAULT_MAX_WAIT, `${what}.maxWait`) }
}

function checkedFallback(fallback: unknown, what: string): readonly FallbackModel[] {
  if (!Array.isArray(fallback))
    throw configError('ai', 'fallback', `${what} is a list of { model, provider? }`)

  for (const [index, entry] of (fallback as unknown[]).entries()) {
    const item = entry as Partial<FallbackModel> | null

    if (typeof item !== 'object' || item === null || typeof item.model !== 'string' || item.model === '')
      throw configError('ai', 'fallback', `${what}[${index}] is { model, provider? }, with the model's name`)
  }

  return fallback as readonly FallbackModel[]
}

// Called by `ai()`, which the app's config runs again on every reload: the settings are replaced.
export function configureResilience({ retry, fallback }: Resilience): void {
  if (retry !== undefined && retry !== false)
    policyOf(retry, 'ai({ retry })')

  if (fallback !== undefined)
    checkedFallback(fallback, 'ai({ fallback })')

  ;(globalThis as { [SLOT]?: Resilience })[SLOT] = { retry, fallback }
}

export interface Plan {
  // Undefined asks once per model.
  policy: Policy | undefined
  fallback: readonly FallbackModel[]
}

// How an ask is retried and falls back: what it names, else what `ai()` set, else one retry of a real provider. The fake answering an ask is no real provider, so the settings of `ai()` are not used for it, as its hooks are not, and it is retried only when the ask names `retry`.
export function planFor(options: Resilience, provider: Provider): Plan {
  const fake = answersAsFake(provider)
  const set = fake ? {} : slot()
  const retry = options.retry ?? set.retry
  const fallback = options.fallback === undefined ? set.fallback ?? [] : checkedFallback(options.fallback, 'ask({ fallback })')

  if (retry === false || (retry === undefined && fake))
    return { policy: undefined, fallback }

  return { policy: policyOf(retry ?? {}, options.retry === undefined ? 'ai({ retry })' : 'ask({ retry })'), fallback }
}

// How long to wait before asking the same model again, or undefined when waiting is no use: a rate limit asking for longer than `maxWait`.
function waitFor(error: AiError, made: number, { backoff, maxWait }: Policy): number | undefined {
  if (error.retryAfter !== undefined) {
    const asked = error.retryAfter * 1000

    // Never shorter than the provider asked, a little longer so asks told the same do not return together.
    return asked > maxWait ? undefined : Math.min(maxWait, asked * (1 + Math.random() * JITTER / 5))
  }

  return Math.min(maxWait, backoff * 2 ** (made - 1)) * (1 - Math.random() * JITTER)
}

// What the model said or did that the reply shows or the loop acts on: a request that sent any is never asked again.
// Thinking is signed for the model that thought it, which Anthropic checks, so a request to another model, as a fallback or a later ask on another model is, leaves out the blocks of the turns that model did not think.
function thinkingFor(messages: ProviderMessage[], by: string): ProviderMessage[] {
  if (!messages.some(message => message.thinking !== undefined && message.thinkingBy !== undefined && message.thinkingBy !== by))
    return messages

  return messages.map(({ thinking, thinkingBy, ...message }) => thinkingBy === undefined || thinkingBy === by ? { ...message, ...thinking !== undefined && { thinking }, thinkingBy } : message)
}

function streamed(piece: Inner): boolean {
  return 'text' in piece || 'reasoning' in piece || 'thinking' in piece || 'toolUse' in piece
}

async function* attempting(targets: Target[], request: ProviderRequest, signal: AbortSignal, policy: Policy | undefined, hooks: Hooks): AsyncGenerator<Inner> {
  const attempts = policy?.attempts ?? 1
  let made = 0

  for (const [index, target] of targets.entries()) {
    const lastTarget = index === targets.length - 1

    signal.throwIfAborted()

    for (let at = 1; at <= attempts; at++) {
      made++

      const began = performance.now()
      const stream = target.provider.stream({ ...request, messages: thinkingFor(request.messages, `${target.provider.name}/${target.model}`), model: target.model }, signal)[Symbol.asyncIterator]()
      const held: Inner[] = []
      let failure: AiError | undefined

      // Pieces are held until the first one the reply shows, so a request that fails before it leaves nothing behind.
      try {
        for (;;) {
          const next = await stream.next()

          if (next.done === true)
            break

          held.push(next.value)

          if (streamed(next.value))
            break
        }
      }
      catch (error) {
        signal.throwIfAborted()

        if (!(error instanceof AiError) || !TRANSIENT.has(error.kind))
          throw error

        failure = error
      }

      if (failure === undefined) {
        try {
          yield { served: { provider: target.provider.name, model: target.model, attempt: made } }
          yield* held
          yield* { [Symbol.asyncIterator]: () => stream }
        }
        finally {
          await stream.return?.()
        }

        return
      }

      const wait = policy === undefined || at === attempts ? undefined : waitFor(failure, at, policy)
      const step: Step = { ms: Math.round(performance.now() - began), firstTokenMs: undefined, usage: undefined, finish: undefined, calls: [], provider: target.provider.name, model: target.model, attempt: made, failed: failure.kind }

      yield { step }

      // The failure that ends the reply is the one its `onError` is told.
      if (wait === undefined && lastTarget)
        throw failure

      tell('onError', hooks.onError, { error: failure }, await hooks.context)

      if (wait === undefined)
        break

      await sleep(wait, { signal })
    }
  }
}

// The provider an ask is sent through: the model asked, then each fallback, each retried as the plan says. A request that fails before the first piece of the reply is asked again; one that streamed something never is.
export function resilient(provider: Provider, model: string, plan: Plan, hooks: Hooks): Streams {
  const targets: Target[] = [{ provider, model }, ...plan.fallback.map((entry) => {
    const chosen = named(entry.model)
    const own = entry.provider ?? chosen?.provider

    return { provider: own === undefined ? provider : given(own), model: chosen?.model ?? entry.model }
  })]

  return { name: provider.name, stream: (request, signal) => attempting(targets, request, signal, plan.policy, hooks) }
}
