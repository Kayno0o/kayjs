import type { ActionProtection, ProofOfWorkOptions, RateStore, ResolvedProtection } from './action-shared'
import { durationSeconds } from './duration'

const DAY = '1d'

// The options with `protect` read: its checks on a level with the rest, what the server reads.
export function resolveProtection(options: ActionProtection<string> | undefined): ResolvedProtection | undefined {
  if (options === undefined)
    return undefined

  const { protect, tool, maxSize, messages } = options

  return Object.fromEntries(Object.entries({ tool, maxSize, messages, ...protect }).filter(([, value]) => value !== undefined))
}

// `proofOfWork` with its defaults, `maxAge` in milliseconds; undefined when it is off.
export function workOf(protection: ResolvedProtection): { difficulty: number, maxAge: number, pretend: boolean, store: RateStore | undefined } | undefined {
  const { proofOfWork } = protection

  if (proofOfWork === undefined || proofOfWork === false)
    return undefined

  const numeric: ProofOfWorkOptions = typeof proofOfWork === 'number' ? { difficulty: proofOfWork } : {}
  const options = typeof proofOfWork === 'object' ? proofOfWork : numeric
  const difficulty = options.difficulty ?? 100_000

  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 1e9)
    throw new Error(`kay: proofOfWork's difficulty is ${difficulty}; it takes a whole number from 1 to 1,000,000,000`)

  return { difficulty, maxAge: durationSeconds(options.maxAge ?? DAY, 'proofOfWork.maxAge') * 1000, pretend: options.pretend === true, store: options.store }
}

// `minTime` in milliseconds, read once it is set.
export function minTimeOf(protection: ResolvedProtection): { after: number, maxAge: number, pretend: boolean } | undefined {
  const { minTime } = protection

  if (minTime === undefined)
    return undefined

  const options = typeof minTime === 'object' ? minTime : { after: minTime }

  return { after: durationSeconds(options.after, 'minTime') * 1000, maxAge: durationSeconds(options.maxAge ?? DAY, 'minTime.maxAge') * 1000, pretend: options.pretend === true }
}

export function honeypotField(protection: ResolvedProtection | undefined): string | undefined {
  const honeypot = protection?.honeypot

  return typeof honeypot === 'object' ? honeypot.field : honeypot
}
