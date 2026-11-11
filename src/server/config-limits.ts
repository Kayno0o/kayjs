import type { HealthConfig, ImagesConfig, LiveConfig } from '../config'
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
  return message.length > ERROR_CHARS ? `${message.slice(0, ERROR_CHARS)}... (${message.length - ERROR_CHARS} more characters)` : message
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

// How many connections one client holds at once unless `live.connections` says otherwise: a few tabs, not a flood.
export const MAX_CONNECTIONS = 20

// `live` from kay.config.ts with its defaults, each limit a whole number from 1.
export function liveLimits(config: LiveConfig | undefined): { connections: number, perMinute: number } {
  const connections = config?.connections ?? MAX_CONNECTIONS
  const perMinute = config?.perMinute ?? DEFAULT_PER_MINUTE

  for (const [name, value] of [['connections', connections], ['perMinute', perMinute]] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new KayError('config-invalid', `kay: live.${name} is ${String(value)}; it takes a whole number from 1`)
  }

  return { connections, perMinute }
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
  perMinute: number | undefined
  maxVariants: number | undefined
  queue: number | undefined
}

// Unless `images.perMinute`, `images.maxVariants` or `images.queue` say otherwise: a page asks for a few variants per image, so a client asking for hundreds is probing the encoder.
const DEFAULT_IMAGE_LIMITS = { perMinute: 120, maxVariants: 256, queue: 128 } as const

// The limits of the image route on variants it has to encode, each a whole number from 1 or `false` for none.
export function imageLimits(images: Pick<ImagesConfig, 'perMinute' | 'maxVariants' | 'queue'> | undefined): ImageLimits {
  const read = (name: keyof ImageLimits): number | undefined => {
    const value = images?.[name] ?? DEFAULT_IMAGE_LIMITS[name]

    if (value === false)
      return undefined

    if (!Number.isSafeInteger(value) || value < 1)
      throw new KayError('config-invalid', `kay: images.${name} is ${String(value)}; it takes a whole number from 1, or false for no limit`)

    return value
  }

  return { perMinute: read('perMinute'), maxVariants: read('maxVariants'), queue: read('queue') }
}

// `images.remoteMaxSize` and `images.remoteTimeout` with their defaults, each refused when it is no positive size or duration.
export function remoteLimits(images: Pick<ImagesConfig, 'remoteMaxSize' | 'remoteTimeout'> | undefined): RemoteLimits {
  return {
    bytes: images?.remoteMaxSize === undefined ? MAX_REMOTE_BYTES : Math.floor(byteSize(images.remoteMaxSize, 'images.remoteMaxSize')),
    timeoutMs: images?.remoteTimeout === undefined ? FETCH_TIMEOUT_MS : Math.round(durationSeconds(images.remoteTimeout, 'images.remoteTimeout') * 1000),
  }
}
