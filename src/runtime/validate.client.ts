import type { Validated, ValidateOptions } from '../server/validate'

export type { Issue, Refusal, Source, Validated, ValidateOptions } from '../server/validate'

// The server's `validate` in the browser. The validator is a chunk of its own, loaded by the first call, so a page whose islands never call `validate` does not fetch it and one that does fetches it once.
// kept: free
export async function validate<Value = unknown>(schema: object, value: unknown, options: ValidateOptions): Promise<Validated<Value>> {
  const { validate: run } = await import('./validate-run.client')

  return run<Value>(schema, value, options)
}
