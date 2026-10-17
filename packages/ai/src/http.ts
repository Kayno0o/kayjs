import { parseEvents } from 'kay/library'
import { AiError } from './errors'

const MESSAGE_LIMIT = 200
const SECONDS = /^\d+$/

export interface ServerEvent {
  event: string
  data: string
}

// What the provider said was wrong, kept short for a log line.
async function reason(response: Response): Promise<string> {
  try {
    const body = await response.text()

    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown } | string, message?: unknown }
      const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message

      return typeof message === 'string' ? message.slice(0, MESSAGE_LIMIT) : body.slice(0, MESSAGE_LIMIT)
    }
    catch {
      return body.slice(0, MESSAGE_LIMIT)
    }
  }
  catch {
    return ''
  }
}

// `Retry-After` in seconds, from the seconds it holds or the date.
function retryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')

  if (header === null)
    return undefined

  if (SECONDS.test(header))
    return Number(header)

  const at = Date.parse(header)

  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

export async function refusal(name: string, response: Response): Promise<AiError> {
  const { status } = response
  const said = await reason(response)
  const detail = said === '' ? '' : `: ${said}`

  if (status === 401 || status === 403)
    return new AiError('auth', `${name} refused the key (${status})${detail}`, { status })

  if (status === 429) {
    const wait = retryAfter(response)

    return new AiError('rate-limited', `${name} is rate limiting (429)${wait === undefined ? '' : `, retry after ${wait} s`}${detail}`, { status, retryAfter: wait })
  }

  if (status >= 500)
    return new AiError('unavailable', `${name} is unavailable (${status})${detail}`, { status })

  return new AiError('invalid', `${name} refused the request (${status})${detail}`, { status })
}

// Posts JSON and gives the stream of events back; an answer that is no success throws what the provider said.
export async function* postEvents(name: string, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): AsyncGenerator<ServerEvent> {
  let response: Response

  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'text/event-stream', ...headers }, body: JSON.stringify(body), signal })
  }
  catch (error) {
    signal.throwIfAborted()

    throw new AiError('network', `${name} could not be reached (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }

  if (!response.ok)
    throw await refusal(name, response)

  if (response.body === null)
    throw new AiError('protocol', `${name} answered with no body`)

  yield* eventsOf(name, response.body, signal)
}

// The events of a body one by one; the body is cancelled as the generator ends, so a reply stopped early stops the provider.
async function* eventsOf(name: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<ServerEvent> {
  const stop = new AbortController()
  const queue: ServerEvent[] = []
  let wake: (() => void) | undefined
  let finished = false
  let failure: { error: unknown } | undefined
  const relay = () => stop.abort()

  signal.addEventListener('abort', relay, { once: true })

  const reading = (async () => {
    try {
      await parseEvents(body, stop.signal, (event, data) => {
        queue.push({ event, data })
        wake?.()

        return undefined
      })
    }
    catch (error) {
      failure = { error }
    }
    finally {
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

    if (failure !== undefined) {
      signal.throwIfAborted()

      throw new AiError('cut', `${name} dropped the connection mid-reply`, { cause: failure.error })
    }
  }
  finally {
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
