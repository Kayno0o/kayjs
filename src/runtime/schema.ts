import { t as schema } from 'elysia'

type Builder = typeof schema

// A string of at least 32 characters that production must set, and development and tests derive from the project path, so a secret needs no placeholder in the app: read it with `defineEnv`.
function Secret(options: Parameters<Builder['String']>[0] = {}): ReturnType<Builder['String']> {
  return schema.String({ ...options, minLength: Math.max(32, (options as { minLength?: number }).minLength ?? 0), requiredInProduction: true, secret: true })
}

// Elysia's schema builder, re-exported so an action's schema needs no import of its own, with `Secret` for `defineEnv`.
export const s: Builder & { Secret: typeof Secret } = { ...schema, Secret }
