import { t as schema } from 'elysia'

type Builder = typeof schema

// A string of at least 32 characters that production must set, and development and tests derive from the project path, so a secret needs no placeholder in the app: read it with `defineEnv`.
function Secret(options: Parameters<Builder['String']>[0] = {}): ReturnType<Builder['String']> {
  return schema.String({ ...options, minLength: Math.max(32, (options as { minLength?: number }).minLength ?? 0), requiredInProduction: true, secret: true })
}

// A `UnionEnum` of a record's keys, typed as their union, for a `select` whose options come from a record of labels.
function UnionKeys<const Keyed extends object>(record: Keyed, options?: Parameters<Builder['UnionEnum']>[1]): ReturnType<typeof schema.UnionEnum<[keyof Keyed & string, ...(keyof Keyed & string)[]]>> {
  const keys = Object.keys(record)

  if (keys.length === 0)
    throw new Error('kay: s.UnionKeys() takes a record with at least one key')

  return schema.UnionEnum(keys as [keyof Keyed & string, ...(keyof Keyed & string)[]], options)
}

// Elysia's schema builder, re-exported so an action's schema needs no import of its own, with `Secret` for `defineEnv` and `UnionKeys`.
export const s: Builder & { Secret: typeof Secret, UnionKeys: typeof UnionKeys } = { ...schema, Secret, UnionKeys }
