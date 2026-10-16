import { readFileSync } from 'node:fs'
import process from 'node:process'

const STATE = /\)\s+(\S)/

// Whether a process still runs: one that ended but that no parent reaped yet is a zombie, which `process.kill(pid, 0)` still reaches, as when an init that reaps slowly, a CI container's, inherits it.
export function alive(pid: number): boolean {
  try {
    const state = STATE.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1]

    return state !== 'Z' && state !== 'X'
  }
  catch {
    return false
  }
}

// Kills what a test left running, which may have ended on its own meanwhile.
export function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  }
  catch {
    // Already gone.
  }
}
