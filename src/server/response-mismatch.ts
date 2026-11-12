import { KayError } from '../compiler/errors'

const mismatches = new WeakMap<object, KayError>()

// The error a response failing its schema is reported as, one per Elysia error so the two hooks that meet it report it once.
export function mismatchOf(error: unknown): KayError {
  const elysia = error as Error
  const known = mismatches.get(elysia)

  if (known)
    return known

  const reported = new KayError('response-schema-mismatch', elysia.message, { cause: elysia, status: 500 })

  mismatches.set(elysia, reported)

  return reported
}
