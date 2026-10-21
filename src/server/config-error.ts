import type { DurationText } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { durationSeconds as durationOf, optionMs as optionOf } from '../runtime/duration'

// The error a setting kay or a library refuses at boot throws, as `kay: <option> is <value>; it takes <what>`, or `kay: <message>` for a problem of another shape (two options that exclude each other, one that needs another).
// The message names the option as the app wrote it (`cms({ pageSize })`), so it needs no library name before it.
export function configError(message: string, options?: ErrorOptions): KayError
export function configError(option: string, value: unknown, takes: string): KayError
export function configError(first: string, second?: unknown, takes?: string): KayError {
  if (takes === undefined)
    return new KayError('config-invalid', `kay: ${first}`, second as ErrorOptions | undefined)

  return new KayError('config-invalid', `kay: ${first} is ${shown(second)}; it takes ${takes}`)
}

function shown(value: unknown): string {
  if (typeof value !== 'object' && typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
    return String(value)

  try {
    return JSON.stringify(value) ?? String(value)
  }
  catch {
    return String(value)
  }
}

// Runs a reader that also runs in the browser, so throws a plain error, and raises what it throws as a `config-invalid` KayError.
export function asConfigError<T>(read: () => T): T {
  try {
    return read()
  }
  catch (error) {
    throw error instanceof Error && !(error instanceof KayError) ? new KayError('config-invalid', error.message, { cause: error }) : error
  }
}

export function durationSeconds(value: unknown, what: string): number {
  return asConfigError(() => durationOf(value, what))
}

export function optionMs(value: DurationText, what: string): number {
  return asConfigError(() => optionOf(value, what))
}
