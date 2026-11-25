// Typed environment variable loader using any Standard Schema validator.

import type { InferOutput, StandardSchemaV1 } from './standard-schema'

const NODE_ENV_KEY = 'NODE_ENV'

/** Reads NODE_ENV at runtime: the dynamic key keeps Bun.build from constant-folding it in compiled binaries. */
export function nodeEnv(): string | undefined {
  return process.env[NODE_ENV_KEY]
}

export function defineEnv<S extends StandardSchemaV1>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): Readonly<InferOutput<S>> {
  const result = schema['~standard'].validate(source)
  if (result instanceof Promise)
    throw new Error('kay: defineEnv() requires a synchronous Standard Schema validator')

  if (result.issues && result.issues.length > 0) {
    const details = result.issues
      .map((issue) => {
        const key = issue.path && issue.path.length > 0
          ? issue.path.map(seg => (typeof seg === 'object' && seg !== null && 'key' in seg ? String(seg.key) : String(seg))).join('.')
          : '(root)'
        return `  - ${key}: ${issue.message}`
      })
      .join('\n')
    throw new Error(`kay: invalid environment variables:\n${details}`)
  }

  const value = (result as { value: InferOutput<S> }).value
  return typeof value === 'object' && value !== null ? Object.freeze({ ...value }) : value
}
