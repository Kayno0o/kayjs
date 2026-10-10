import type { Duration } from 'kay'

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
const DURATION = /^(\d+(?:\.\d+)?)([smhdw])$/

// A kay `Duration`, seconds or a string such as '30s', in milliseconds; `what` names it in the error a duration that is none throws.
export function milliseconds(duration: Duration, what: string): number {
  const match = typeof duration === 'string' ? DURATION.exec(duration) : null
  const ms = typeof duration === 'number' ? duration * 1000 : match ? Number(match[1]) * UNITS[match[2]!]! : Number.NaN

  if (!Number.isFinite(ms) || ms <= 0)
    throw new Error(`kayjs-mail: ${what} is ${String(duration)}; it takes a positive duration, seconds or a string such as '30s'`)

  return ms
}
