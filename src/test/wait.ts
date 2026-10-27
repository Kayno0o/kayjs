import type { Duration } from '../runtime/duration'
import { optionMs } from '../runtime/duration'

export interface WaitUntilOptions {
  // How long to wait, 5 seconds by default.
  timeout?: Duration | undefined
  // Named in the failure when the wait times out.
  what?: string | undefined
}

const TIMEOUT_MS = 5000
const POLL_MS = 10

// Polls `condition`, sync or async, until it returns something truthy and resolves with that value. It sleeps with `Bun.sleep`, which fake timers freeze: it needs real timers.
export async function waitUntil<T>(condition: () => T | Promise<T>, options: WaitUntilOptions = {}): Promise<Exclude<Awaited<T>, false | 0 | '' | null | undefined>> {
  const budget = options.timeout === undefined ? TIMEOUT_MS : optionMs(options.timeout, 'the waitUntil timeout')
  const start = Bun.nanoseconds()

  while (true) {
    const value = await condition()

    if (isTruthy(value))
      return value as Exclude<Awaited<T>, false | 0 | '' | null | undefined>

    if ((Bun.nanoseconds() - start) / 1e6 >= budget)
      throw new Error(`kay: waited ${budget}ms for ${options.what ?? 'the condition to hold'}; the last value was ${Bun.inspect(value)}`)

    await Bun.sleep(POLL_MS)
  }
}

function isTruthy(value: unknown): boolean {
  return Boolean(value)
}
