import process from 'node:process'
import { kayLog } from '../runtime/log'
import { WORKER_INDEX } from './parent'

// What the server writes to a file of this machine because the app's `store` names no database for it: a deploy or a second replica does not carry it along. Each is one sentence saying where and what to do.
const kept = new Map<string, string>()
let warned = false

export function noteLocalFile(what: string, sentence: string): void {
  kept.set(what, sentence)
}

// Production warns once, at boot, for everything noted: the first worker alone when several run.
export function warnOfLocalFiles(): void {
  if (warned || kept.size === 0 || process.env.NODE_ENV !== 'production' || (process.env[WORKER_INDEX] !== undefined && process.env[WORKER_INDEX] !== '0'))
    return

  warned = true
  kayLog('warn', [...kept.values()].join('; '))
}

// Forgets what was noted, for the next test site.
export function resetLocalFiles(): void {
  kept.clear()
  warned = false
}
