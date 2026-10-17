import type { HealthConfig, ImagesConfig, LiveConfig } from '../config'
import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { byteSize } from '../runtime/byte-size'
import { durationSeconds } from '../runtime/duration'

// The limits kay.config.ts may move, each read with its default and refused naming its option: kept apart from the server modules using them, so `kay check` and the language server validate them without loading Elysia.

// A check slower than this fails unless `health.timeout` says otherwise, so a hung database never hangs the probe with it.
const DEFAULT_CHECK_TIMEOUT = 5
const MAX_TIMER_MS = 2 ** 31 - 1

// The milliseconds a health check may take, `health.timeout` read once per use: a value that is no positive duration throws naming the option.
export function healthTimeoutMs(config: HealthConfig | undefined): number {
  const ms = durationSeconds(config?.timeout ?? DEFAULT_CHECK_TIMEOUT, 'health.timeout') * 1000

  // A timer past this fires at once.
  if (ms > MAX_TIMER_MS)
    throw new KayError('config-invalid', `kay: health.timeout is ${String(config?.timeout)}; it takes at most 24 days`)

  return ms
}

export function shutdownSeconds(timeout: Duration): number {
  return durationSeconds(timeout, 'shutdownTimeout')
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

const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/
// Headers the id would overwrite or echo something else through.
const RESERVED_HEADERS = new Set(['authorization', 'content-length', 'content-type', 'cookie', 'host', 'location', 'set-cookie'])

// Refuses a `requestIdHeader` that is no header's name.
export function checkRequestIdHeader(name: string | undefined): void {
  if (name !== undefined && (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())))
    throw new KayError('config-invalid', `kay: requestIdHeader is ${JSON.stringify(name)}; it names a header of its own, such as x-correlation-id`)
}

// Past this, a download is cut off unless `images.remoteMaxSize` says otherwise: an image worth resizing is a few megabytes.
export const MAX_REMOTE_BYTES = 25 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 10_000

export interface RemoteLimits {
  bytes: number
  timeoutMs: number
}

// `images.remoteMaxSize` and `images.remoteTimeout` with their defaults, each refused when it is no positive size or duration.
export function remoteLimits(images: Pick<ImagesConfig, 'remoteMaxSize' | 'remoteTimeout'> | undefined): RemoteLimits {
  return {
    bytes: images?.remoteMaxSize === undefined ? MAX_REMOTE_BYTES : Math.floor(byteSize(images.remoteMaxSize, 'images.remoteMaxSize')),
    timeoutMs: images?.remoteTimeout === undefined ? FETCH_TIMEOUT_MS : Math.round(durationSeconds(images.remoteTimeout, 'images.remoteTimeout') * 1000),
  }
}
