// Typed environment variable loader using any Standard Schema validator.

import type { InferOutput, StandardSchemaV1 } from './standard-schema'
import { getAppContext } from '../plugins/context'
import { formatIssuePath, validateSchemaSync } from './standard-schema'

const NODE_ENV_KEY = 'NODE_ENV'

/** Reads NODE_ENV at runtime (preferring the active AppRuntimeContext when set): the dynamic key keeps Bun.build from constant-folding it in compiled binaries. */
export function nodeEnv(): string | undefined {
  return getAppContext()?.nodeEnv ?? process.env[NODE_ENV_KEY]
}

export function defineEnv<S extends StandardSchemaV1>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): Readonly<InferOutput<S>> {
  const result = validateSchemaSync(
    schema,
    source,
    'kay: defineEnv() requires a synchronous Standard Schema validator',
  )
  if (!result.ok) {
    const details = result.issues
      .map(issue => `  - ${formatIssuePath(issue) || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`kay: invalid environment variables:\n${details}`)
  }

  return typeof result.value === 'object' && result.value !== null
    ? Object.freeze({ ...result.value })
    : result.value
}
