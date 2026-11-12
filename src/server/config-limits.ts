import type { HealthConfig, ImagesConfig, LiveConfig } from '../config'
import type { RateLimit } from '../runtime/action'
import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { durationSeconds, optionMs } from '../runtime/duration'

// The limits kay.config.ts may move, each read with its default and refused naming its option: kept apart from the server modules using them, so `kay check` and the language server validate them without loading Elysia.

// A check slower than this fails unless `health.timeout` says otherwise, so a hung database never hangs the probe with it.
const DEFAULT_CHECK_TIMEOUT = '5s'

export const MAX_TIMER_MS = 2 ** 31 - 1

// The most characters of a failure kept with its job: an error carrying a response body or a command's output would fill the store, which the jobs page and the dev tool read whole.
export const ERROR_CHARS = 2000

export function cappedError(message: string): string {
  if (message.length <= ERROR_CHARS)
    return message

  // A cut between the halves of a surrogate pair would leave one alone.
  const kept = message.charCodeAt(ERROR_CHARS - 1) >= 0xD800 && message.charCodeAt(ERROR_CHARS - 1) <= 0xDBFF ? ERROR_CHARS - 1 : ERROR_CHARS

  return `${message.slice(0, kept)}... (${message.length - kept} more characters)`
}

// The milliseconds a health check may take, `health.timeout` read once per use: a value that is no positive duration throws naming the option.
export function healthTimeoutMs(config: HealthConfig | undefined): number {
  const ms = durationSeconds(config?.timeout ?? DEFAULT_CHECK_TIMEOUT, 'health.timeout') * 1000

  // A timer past this fires at once.
  if (ms > MAX_TIMER_MS)
    throw new KayError('config-invalid', `kay: health.timeout is ${String(config?.timeout)}; it takes at most 24 days`)

  return ms
}

export function shutdownSeconds(timeout: Duration): number {
  return durationSeconds(timeout, 'serve.shutdownTimeout')
}

// How long a page's loads may take in development before kay warns: `observe.loadBudget`, 300 ms when unset, none for `false`.
export const DEFAULT_LOAD_BUDGET_MS = 300

export function loadBudgetMs(value: Duration | false | undefined): number | undefined {
  return value === undefined ? DEFAULT_LOAD_BUDGET_MS : timeoutMs(value, 'observe.loadBudget')
}

// A timeout as milliseconds: `false` and an unset value mean none; anything else is a positive duration.
export function timeoutMs(value: Duration | false | undefined, what: string): number | undefined {
  if (value === undefined || value === false)
    return undefined

  const ms = optionMs(value, what)

  if (ms > MAX_TIMER_MS)
    throw new KayError('config-invalid', `kay: ${what} is ${value}; it takes at most 24 days`)

  return ms
}

const DEFAULT_PER_MINUTE = 120
const DEFAULT_IMAGE_PER_MINUTE = 120
const MINUTE_MS = 60_000

// How many connections one client holds at once unless `live.connections` says otherwise: a few tabs, not a flood.
export const MAX_CONNECTIONS = 20

// A rate limit as the server counts it: `max` requests in `windowMs`.
export interface RateWindowMs {
  max: number
  windowMs: number
}

// A `rateLimit` option of the config: `{ max, window }`, `false` for none, or the number a minute it was before 1.98 (`legacy`, read under `legacy.name`, which is `perMinute` or the number form of `rateLimit` itself). Left out, `fallback` a minute.
export function rateLimitOf(what: string, rateLimit: Pick<RateLimit, 'max' | 'window'> | number | false | undefined, legacy: { name: string, value: number | false | undefined }, fallback: number): RateWindowMs | undefined {
  if (rateLimit !== undefined && legacy.value !== undefined && typeof rateLimit !== 'number')
    throw new KayError('config-invalid', `kay: ${what} sets both rateLimit and its older spelling ${legacy.name}; keep rateLimit`)

  const given = typeof rateLimit === 'number' ? rateLimit : rateLimit ?? legacy.value

  if (given === false)
    return undefined

  const object = typeof given === 'object' ? given : undefined
  const max = object?.max ?? (object === undefined ? given : undefined) ?? fallback
  const name = object === undefined && given !== undefined ? legacy.name : `${what}.rateLimit.max`

  if (!Number.isSafeInteger(max) || (max as number) < 1)
    throw new KayError('config-invalid', `kay: ${name.includes('.') ? name : `${what}.${name}`} is ${String(max)}; it takes a whole number from 1, or false for no limit`)

  return { max: max as number, windowMs: object === undefined ? MINUTE_MS : optionMs(object.window, `${what}.rateLimit.window`) }
}

// `live` from kay.config.ts with its defaults, each limit a whole number from 1.
export function liveLimits(config: LiveConfig | undefined): { connections: number, rate: RateWindowMs | undefined } {
  const connections = config?.connections ?? MAX_CONNECTIONS

  if (!Number.isSafeInteger(connections) || connections < 1)
    throw new KayError('config-invalid', `kay: live.connections is ${String(connections)}; it takes a whole number from 1`)

  return { connections, rate: rateLimitOf('live', config?.rateLimit, { name: 'live.perMinute', value: config?.perMinute }, DEFAULT_PER_MINUTE) }
}

// Refuses a `timeZone` the engine does not know.
export function checkTimeZone(zone: string | undefined): void {
  if (zone === undefined)
    return

  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0)
  }
  catch {
    throw new KayError('config-invalid', `kay: timeZone is ${JSON.stringify(zone)}; it names an IANA time zone, such as Europe/Paris`)
  }
}

const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/
// Headers the id would overwrite or echo something else through.
const RESERVED_HEADERS = new Set(['authorization', 'content-length', 'content-type', 'cookie', 'host', 'location', 'set-cookie'])

// Refuses an `observe.requestIdHeader` that is no header's name.
export function checkRequestIdHeader(name: string | undefined): void {
  if (name !== undefined && (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())))
    throw new KayError('config-invalid', `kay: observe.requestIdHeader is ${JSON.stringify(name)}; it names a header of its own, such as x-correlation-id`)
}

// Past this, a download is cut off unless `images.remoteMaxSize` says otherwise: an image worth resizing is a few megabytes.
export const MAX_REMOTE_BYTES = 25 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 10_000

export interface RemoteLimits {
  bytes: number
  timeoutMs: number
}

export interface ImageLimits {
  rate: RateWindowMs | undefined
  maxVariants: number | undefined
  queue: number | undefined
}

// Unless `images.rateLimit`, `images.maxVariants` or `images.queue` say otherwise: a page asks for a few variants per image, so a client asking for hundreds is probing the encoder.
const DEFAULT_IMAGE_LIMITS = { maxVariants: 256, queue: 128 } as const

// The limits of the image route on variants it has to encode, each a whole number from 1 or `false` for none.
export function imageLimits(images: Pick<ImagesConfig, 'rateLimit' | 'perMinute' | 'maxVariants' | 'queue'> | undefined): ImageLimits {
  const read = (name: 'maxVariants' | 'queue'): number | undefined => {
    const value = images?.[name] ?? DEFAULT_IMAGE_LIMITS[name]

    if (value === false)
      return undefined

    if (!Number.isSafeInteger(value) || value < 1)
      throw new KayError('config-invalid', `kay: images.${name} is ${String(value)}; it takes a whole number from 1, or false for no limit`)

    return value
  }

  return { rate: rateLimitOf('images', images?.rateLimit, { name: 'images.perMinute', value: images?.perMinute }, DEFAULT_IMAGE_PER_MINUTE), maxVariants: read('maxVariants'), queue: read('queue') }
}

// `images.remoteMaxSize` and `images.remoteTimeout` with their defaults, each refused when it is no positive size or duration.
export function remoteLimits(images: Pick<ImagesConfig, 'remoteMaxSize' | 'remoteTimeout'> | undefined): RemoteLimits {
  return {
    bytes: images?.remoteMaxSize === undefined ? MAX_REMOTE_BYTES : Math.floor(byteSize(images.remoteMaxSize, 'images.remoteMaxSize')),
    timeoutMs: images?.remoteTimeout === undefined ? FETCH_TIMEOUT_MS : Math.round(durationSeconds(images.remoteTimeout, 'images.remoteTimeout') * 1000),
  }
}
