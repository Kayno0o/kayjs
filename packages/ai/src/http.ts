import type { Timeouts } from './types'
import { optionMs, parseEvents } from 'kay/library'
import { AiError } from './errors'

const MESSAGE_LIMIT = 200
// A shorter key would blank out ordinary words.
const MIN_REDACTED = 8
const SECONDS = /^\d+$/
const HTTP_DATE = /^[A-Z][a-z]{2}, \d/

export interface ServerEvent {
  event: string
  data: string
}

// What the provider said was wrong, kept short for a log line, and the code it gave it.
async function reason(response: Response): Promise<{ said: string, code: string }> {
  try {
    const body = await response.text()

    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown, code?: unknown } | string, message?: unknown }
      const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message
      const code = typeof parsed.error === 'object' ? parsed.error.code : undefined

      return { said: typeof message === 'string' ? message.slice(0, MESSAGE_LIMIT) : body.slice(0, MESSAGE_LIMIT), code: typeof code === 'string' ? code : '' }
    }
    catch {
      return { said: body.slice(0, MESSAGE_LIMIT), code: '' }
    }
  }
  catch {
    return { said: '', code: '' }
  }
}

// `Retry-After` in seconds, from the seconds it holds or the date.
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')

  if (header === null)
    return undefined

  if (SECONDS.test(header))
    return Number(header)

  const at = HTTP_DATE.test(header) ? Date.parse(header) : Number.NaN

  return Number.isNaN(at) || at <= Date.now() ? undefined : Math.ceil((at - Date.now()) / 1000)
}

// What the provider said wrong with `secret` hidden, as some echo the key they refused.
export async function refusal(name: string, response: Response, secret?: string): Promise<AiError> {
  const { status } = response
  const { said: raw, code } = await reason(response)
  const said = secret !== undefined && secret.length >= MIN_REDACTED ? raw.replaceAll(secret, '[key]') : raw
  const quota = code === 'insufficient_quota'
  const detail = said === '' ? '' : `: ${said}`

  if (status === 401 || status === 403)
    return new AiError('auth', `${name} refused the key (${status})${detail}`, { status })

  // Out of credit, not out of turns: waiting does not help.
  if (status === 429 && !quota) {
    const wait = retryAfter(response)

    return new AiError('rate-limited', `${name} is rate limiting (429)${wait === undefined ? '' : `, retry after ${wait} s`}${detail}`, { status, retryAfter: wait })
  }

  if (status >= 500)
    return new AiError('unavailable', `${name} is unavailable (${status})${detail}`, { status })

  return new AiError('invalid', `${name} refused the request (${status})${detail}`, { status })
}

// Posts JSON and gives the stream of events back; an answer that is no success throws what the provider said.
export async function* postEvents(name: string, url: string, headers: Record<string, string>, body: unknown, timeouts: Timeouts, signal: AbortSignal, secret?: string): AsyncGenerator<ServerEvent> {
  let response: Response
  const connecting = new AbortController()
  const connect = optionMs(timeouts.connect, 'the connect timeout', 'kayjs-ai')
  const timer = setTimeout(() => connecting.abort(), connect)

  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...headers }, body: JSON.stringify(body), signal: AbortSignal.any([signal, connecting.signal]), redirect: 'error' })
  }
  catch (error) {
    signal.throwIfAborted()

    if (connecting.signal.aborted)
      throw new AiError('timeout', `${name} did not answer within ${connect} ms`, { cause: error })

    throw new AiError('network', `${name} could not be reached (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  finally {
    clearTimeout(timer)
  }

  if (!response.ok)
    throw await refusal(name, response, secret)

  const type = response.headers.get('content-type') ?? ''

  // A server ignoring `stream: true` answers the whole reply as one JSON value, which no event stream parses.
  if (type.includes('application/json'))
    throw new AiError('protocol', `${name} answered with JSON, not an event stream: it does not stream`)

  if (response.body === null)
    throw new AiError('protocol', `${name} answered with no body`)

  yield* eventsOf(name, response.body, optionMs(timeouts.idle, 'the idle timeout', 'kayjs-ai'), signal)
}

// The events of a body one by one; the body is cancelled as the generator ends, so a reply stopped early stops the provider.
async function* eventsOf(name: string, body: ReadableStream<Uint8Array>, idle: number, signal: AbortSignal): AsyncGenerator<ServerEvent> {
  const stop = new AbortController()
  const queue: ServerEvent[] = []
  let wake: (() => void) | undefined
  let finished = false
  let failure: { error: unknown } | undefined
  const relay = () => stop.abort()
  let silent = false
  let watchdog: ReturnType<typeof setTimeout> | undefined
  // Every chunk starts the wait again, so a provider that keeps sending, a keep-alive comment included, is never cut.
  const watch = () => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => {
      silent = true
      stop.abort()
    }, idle)
  }

  signal.addEventListener('abort', relay, { once: true })

  watch()

  const reading = (async () => {
    try {
      await parseEvents(body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform: (chunk, output) => {
        watch()
        output.enqueue(chunk)
      } })), stop.signal, (event, data) => {
        queue.push({ event, data })
        wake?.()

        return undefined
      })
    }
    catch (error) {
      failure = { error }
    }
    finally {
      clearTimeout(watchdog)
      finished = true
      wake?.()
    }
  })()

  try {
    for (;;) {
      const next = queue.shift()

      if (next !== undefined) {
        yield next

        continue
      }

      if (finished)
        break

      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }

    signal.throwIfAborted()

    if (silent)
      throw new AiError('timeout', `${name} sent nothing for ${idle} ms mid-reply`)

    if (failure !== undefined) {
      throw new AiError('cut', `${name} dropped the connection mid-reply`, { cause: failure.error })
    }
  }
  finally {
    clearTimeout(watchdog)
    signal.removeEventListener('abort', relay)
    stop.abort()
    await reading
  }
}

// The event's JSON, or a protocol error naming what was malformed.
export function json(name: string, data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data)

    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>
  }
  catch {}

  throw new AiError('protocol', `${name} sent an event that is no JSON object: ${data.slice(0, 80)}`)
}
