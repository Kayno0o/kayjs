import type { TSchema } from 'elysia'
import type { TypeCheck } from 'elysia/type-system'
import { TypeCompiler } from 'elysia/type-system'

// What a user's app data is held to: the top-level fields the app's schema declares, and the schema's check.
export interface UserDataRules {
  keys: string[]
  check: TypeCheck<TSchema>
}

// The most JSON a user's app data may take, so a profile cannot fill a row.
const MOST_DATA_LENGTH = 16_384

export function userDataRules(schema: TSchema): UserDataRules {
  const properties = (schema as { properties?: Record<string, unknown> }).properties

  if (properties === undefined)
    throw new Error('kayjs-auth: `user` is an object schema, such as `s.Object({ avatar: s.Optional(s.String()) })`')

  return { keys: Object.keys(properties), check: TypeCompiler.Compile(schema) }
}

// `held` with the declared fields of `given` laid over it, as the JSON the store keeps, or undefined when what results is no JSON the schema accepts or is too large. A field the schema does not declare is dropped, whatever its name, and one `given` leaves out or sets to undefined keeps its value.
export function mergedData(rules: UserDataRules, held: Record<string, unknown> | undefined, given: unknown): Record<string, unknown> | undefined {
  if (typeof given !== 'object' || given === null || Array.isArray(given))
    return undefined

  const next: Record<string, unknown> = { ...held }

  for (const key of rules.keys) {
    const value = Object.hasOwn(given, key) ? (given as Record<string, unknown>)[key] : undefined

    if (value !== undefined)
      next[key] = value
  }

  const text = JSON.stringify(next)

  if (text.length > MOST_DATA_LENGTH)
    return undefined

  const json = JSON.parse(text) as Record<string, unknown>

  return rules.check.Check(json) ? json : undefined
}
