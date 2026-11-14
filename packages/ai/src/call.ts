import type { Duration } from 'kay'
import type { Target } from './retry'
import type { CallOptions, EmbedRequest, ErrorHookCall, FinishHookCall, SpeakRequest, Step, TranscribeRequest } from './types'
import { sleep } from '@kaynooo/utils'
import { configError, currentRequest, durationSeconds } from 'kay/library'
import { CALLS, chooseFor, given } from './config'
import { AiError } from './errors'
import { hooksFor, tell } from './hooks'
import { named } from './models'
import { planFor, targetsOf, TRANSIENT, waitFor } from './retry'

const DEFAULT_CALL_TIMEOUT = '2m'
const DEFAULT_CONNECT = '30s'
const DEFAULT_IDLE = '60s'
// A timer takes at most 2^31 - 1 ms (about 24 days) and fires at once past it.
const MAX_TIMER_MS = 2 ** 31 - 1

export type Call = keyof typeof CALLS

interface Shapes {
  transcribe: { request: TranscribeRequest, result: string }
  speak: { request: SpeakRequest, result: Blob }
  embed: { request: EmbedRequest, result: number[][] }
}

// What a caller gives of a request: the model and the timeout are the call's to settle, as they change with each fallback and retry.
type Given<C extends Call> = Omit<Shapes[C]['request'], 'model' | 'timeout'>

const milliseconds = (value: Duration, what: string) => Math.ceil(durationSeconds(value, what) * 1000)

// How long the whole of a call that answers whole may take: a single duration, or the `connect` and `idle` of an object added up.
function wholeTimeout(timeout: CallOptions['timeout'], what: string): Duration {
  if (timeout === undefined)
    return DEFAULT_CALL_TIMEOUT

  const total = typeof timeout === 'object'
    ? milliseconds(timeout.connect ?? DEFAULT_CONNECT, `${what}.connect`) + milliseconds(timeout.idle ?? DEFAULT_IDLE, `${what}.idle`)
    : milliseconds(timeout, what)

  return `${Math.min(MAX_TIMER_MS, total)}ms`
}

function text(call: Call, result: Shapes[Call]['result']): string {
  return call === 'transcribe' ? result as string : ''
}

// What a `transcribe`, `speak` or `embed` call is sent with: `send` asks the provider as an ask is asked, retried and fallen back on a transient failure and with its hooks told, and the voice the environment names, and what stops it.
export function setUp<C extends Call>(call: C, options: CallOptions) {
  const hit = options.model === undefined ? undefined : named(options.model)
  const handmade = options.provider ?? hit?.provider
  const chosen = handmade === undefined ? chooseFor(call) : { provider: given(handmade), model: handmade.model, voice: undefined }
  const model = hit?.model ?? options.model ?? chosen.model

  if (model === undefined)
    throw configError('ai', 'model', `no model for ${call}(); set ${CALLS[call].model} or pass { model }`)

  if (chosen.provider[call] === undefined)
    throw new AiError('unsupported', `${chosen.provider.name} has no ${CALLS[call].what}`)

  const whole = wholeTimeout(options.timeout, `${call}({ timeout })`)
  const signals = [currentRequest()?.signal, options.signal].filter(signal => signal !== undefined)
  const signal = AbortSignal.any(signals)
  const plan = planFor(options, chosen.provider)
  const targets = targetsOf(chosen.provider, model, plan)
  const hooks = hooksFor(options, chosen.provider)
  const steps: Step[] = []

  async function attempt(target: Target, request: Given<C>, made: number): Promise<Shapes[C]['result']> {
    const method = target.provider[call] as ((request: Shapes[C]['request'], signal: AbortSignal) => Promise<Shapes[C]['result']>) | undefined

    if (method === undefined)
      throw new AiError('unsupported', `${target.provider.name} has no ${CALLS[call].what}`)

    const began = performance.now()
    const step = (failed: AiError['kind'] | undefined): Step => ({ ms: Math.round(performance.now() - began), firstTokenMs: undefined, usage: undefined, finish: failed === undefined ? 'stop' : undefined, calls: [], provider: target.provider.name, model: target.model, attempt: made, failed })

    try {
      const result = await method({ ...request, model: target.model, timeout: whole } as Shapes[C]['request'], signal)

      steps.push(step(undefined))
      tell('onStep', hooks.onStep, steps.at(-1)!, await hooks.context)

      return result
    }
    catch (error) {
      signal.throwIfAborted()

      if (error instanceof AiError && TRANSIENT.has(error.kind)) {
        steps.push(step(error.kind))
        tell('onStep', hooks.onStep, steps.at(-1)!, await hooks.context)
      }

      throw error
    }
  }

  // Each model in turn, each asked as often as the plan says; an error that is no transient failure, or the last of them, ends the call.
  async function send(request: Given<C>): Promise<Shapes[C]['result']> {
    const attempts = plan.policy?.attempts ?? 1
    let made = 0

    for (const [index, target] of targets.entries()) {
      for (let at = 1; at <= attempts; at++) {
        signal.throwIfAborted()
        made++

        try {
          const result = await attempt(target, request, made)
          const done: FinishHookCall = { text: text(call, result), usage: undefined, steps, finish: 'stop', stopped: false }

          tell('onSuccess', hooks.onSuccess, done, await hooks.context)

          return result
        }
        catch (error) {
          signal.throwIfAborted()

          const wait = error instanceof AiError && TRANSIENT.has(error.kind) && plan.policy !== undefined && at < attempts ? waitFor(error, at, plan.policy) : undefined
          const over = !(error instanceof AiError && TRANSIENT.has(error.kind)) || (wait === undefined && index === targets.length - 1)

          tell('onError', hooks.onError, { error } satisfies ErrorHookCall, await hooks.context)

          if (over)
            throw error

          if (wait === undefined)
            break

          await sleep(wait, { signal })
        }
      }
    }

    throw new AiError('unavailable', `${call}() made no request`)
  }

  return { send, voice: chosen.voice, signal }
}
