import type { Duration } from '../runtime/duration'
import { KayError } from '../compiler/errors'
import { durationSeconds as durationOf, optionMs as optionOf } from '../runtime/duration'

export type ConfigLibrary = 'ai' | 'auth' | 'cms' | 'mail' | 'ui'

const LIBRARIES: ReadonlySet<unknown> = new Set<ConfigLibrary>(['ai', 'auth', 'cms', 'mail', 'ui'])

// The error a setting kay or a library refuses at boot throws.
// A library names itself and the option as `configError('cms', 'pageSize', message)`, and the message ends on where the option is documented, `kayjs-cms/llms.txt`.
// The older forms stay accepted: `configError(option, value, takes)` prints `kay: <option> is <value>; it takes <what>`, and `configError(message)` prints `kay: <message>`.
export function configError(library: ConfigLibrary, option: string, message: string, options?: ErrorOptions): KayError
export function configError(message: string, options?: ErrorOptions): KayError
export function configError(option: string, value: unknown, takes: string): KayError
export function configError(first: string, second?: unknown, third?: string | ErrorOptions, fourth?: ErrorOptions): KayError {
  // An old three-string call whose option is literally a library name reads as the new form, accepted for the three-minor window.
  if (LIBRARIES.has(first) && typeof second === 'string' && typeof third === 'string')
    return new KayError('config-invalid', `kay: ${third} (kayjs-${first} option \`${second}\`: kayjs-${first}/llms.txt)`, fourth)

  if (third === undefined)
    return new KayError('config-invalid', `kay: ${first}`, second as ErrorOptions | undefined)

  return new KayError('config-invalid', `kay: ${first} is ${shown(second)}; it takes ${third as string}`)
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

export function optionMs(value: Duration, what: string): number {
  return asConfigError(() => optionOf(value, what))
}
