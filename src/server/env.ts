import type { Elysia, Static, TSchema } from 'elysia'
import type { PublicFieldsOf, WithPublicFields } from '../runtime/env'
import type { EnvSchemaRecord } from './env-state'
import process from 'node:process'
import { t } from 'elysia'
import { KayError } from '../compiler/errors'
import { PUBLIC_ENV } from '../runtime/env'
import { fixedReply } from './compress'
import { devSecret } from './dev-secret'
import { building, PUBLIC_ENV_PATH, recordEnv } from './env-state'
import { readFields } from './query'

const OPTIONAL = Symbol.for('TypeBox.Optional')

// A `s.Object` of the variables, each read on its own.
export type EnvSchema = TSchema & { properties: Record<string, TSchema> }

// The environment read once against `schema`, as the server boots: numbers and booleans from their text, defaults filled in, and every variable missing or refused named in the error that stops it.
// Holds the declared names only, so logging it never shows the rest of the environment.
// A field marked `s.Public` reaches islands as `publicEnv` from `kay`, with no config key; a name such as `STRIPE_SECRET` or `DATABASE_URL` is refused.
// A field with `requiredInProduction: true` is required in production with its default dropped, and outside production takes its default, stays `undefined` under `s.Optional`, or is `''` when it has neither; `s.Secret()` is one that development and tests give a value derived from the project path; `kay env` lists each as required in production.
export function defineEnv<Schema extends EnvSchema>(declared: Schema, source: Record<string, string | undefined> = process.env): Static<Schema> & (keyof PublicFieldsOf<Schema> extends never ? unknown : WithPublicFields<Schema>) {
  recordEnv(declared, defineEnv)

  const production = source.NODE_ENV === 'production'
  const input: Record<string, string> = {}

  for (const name of Object.keys(declared.properties)) {
    const value = source[name]

    // An empty variable is how a `.env` file says it is not set, so the default or `s.Optional` applies rather than `''` failing the schema; nothing tells `KEY=` from `KEY=""` by the time it is read.
    if (value !== undefined && value !== '')
      input[name] = value
  }

  // Outside production a required-in-production field left out is not read against the schema: its placeholder is added to the result, so a pattern or minLength cannot refuse it.
  const placeholders = production ? {} : placeholdersFor(declared, input, source.NODE_ENV)
  const schema = production ? requiredInProduction(declared) : without(declared, placeholders)
  const read = readFields(schema, input, false)

  if (!('refused' in read)) {
    const values = { ...read.value, ...placeholders }

    exposePublic(declared, values, 's.Public')

    return values as ReturnType<typeof defineEnv<Schema>>
  }

  if (!building())
    throw new KayError('env-invalid', `kay: the environment does not match its schema\n${[...read.refused].map(([name, message]) => `  ${name}: ${message}`).join('\n')}`)

  // The variables the build has, read on their own; a refusal of the whole object, named '', is left to the server.
  const valid = t.Object(Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !read.refused.has(name))))
  const env = { ...(readFields(valid, input, false) as { value: Record<string, unknown> }).value, ...placeholders }

  for (const [name, message] of read.refused) {
    if (name === '')
      continue

    Object.defineProperty(env, name, {
      enumerable: true,
      get: () => {
        throw new KayError('env-invalid', `kay: ${name} does not match the environment's schema (${message}), and kay build runs without the server's environment; read it where the server runs, such as in an action, or leave the page reading it out of the build`)
      },
    })
  }

  exposePublic(declared, env, 's.Public')

  return env as ReturnType<typeof defineEnv<Schema>>
}

function without<Schema extends EnvSchema>(schema: Schema, placeholders: Record<string, string>): Schema {
  if (Object.keys(placeholders).length === 0)
    return schema

  return t.Object(Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !(name in placeholders)))) as unknown as Schema
}

// What development and tests give a `requiredInProduction` string with no default that the environment leaves out: a derived value for a secret, `''` otherwise.
function placeholdersFor(schema: EnvSchema, input: Record<string, string>, mode: string | undefined): Record<string, string> {
  const placeholders: Record<string, string> = {}

  for (const [name, field] of Object.entries(schema.properties)) {
    const { requiredInProduction: production, default: fallback, secret, type } = field as { requiredInProduction?: unknown, default?: unknown, secret?: unknown, type?: unknown }

    if (production !== true || name in input || fallback !== undefined || OPTIONAL in field || type !== 'string')
      continue

    // A secret is derived only where it is surely development, `kay dev` and `bun test` setting these; anywhere else it is required as any string is.
    if (secret === true && mode !== 'development' && mode !== 'test')
      continue

    placeholders[name] = secret === true ? devSecret(name) : ''
  }

  return placeholders
}

// The schema with every `requiredInProduction` field made required and stripped of its default.
function requiredInProduction<Schema extends EnvSchema>(schema: Schema): Schema {
  if (!Object.values(schema.properties).some(field => (field as { requiredInProduction?: unknown }).requiredInProduction === true))
    return schema

  return t.Object(Object.fromEntries(Object.entries(schema.properties).map(([name, field]) => {
    if ((field as { requiredInProduction?: unknown }).requiredInProduction !== true)
      return [name, field]

    const required: Record<string | symbol, unknown> = { ...field }

    delete required.default
    delete required[OPTIONAL]

    return [name, required]
  }))) as unknown as Schema
}

// One variable of a schema as `kay env` lists it.
export interface EnvVariable {
  name: string
  type: string
  // `'always'` when no default takes its place, `'production'` when only production needs a value, `false` when it is optional or defaulted.
  required: 'always' | 'production' | false
  default?: unknown
  description?: string
  // A value no visitor may read, which development and tests derive from the project path.
  secret?: true
  // A variable an island reads as `publicEnv`: `s.Public`.
  public?: true
}

// What a schema declares, as `defineEnv` reads it: each name with its type, whether it is required and its default.
export function describeEnv(schema: EnvSchemaRecord): EnvVariable[] {
  const required = new Set((schema as { required?: string[] }).required ?? [])

  return Object.entries(schema.properties).map(([name, field]) => {
    const { default: fallback, description, requiredInProduction: production, secret, public: isPublic, type, anyOf, format } = field as { public?: unknown, default?: unknown, description?: unknown, requiredInProduction?: unknown, secret?: unknown, type?: unknown, anyOf?: { type?: unknown }[], format?: unknown }
    // A number or boolean is a union with its text, the form it is read from.
    const parts = anyOf?.map(part => part.type).filter(part => typeof part === 'string') ?? []
    const kinds = parts.length > 1 ? parts.filter(part => part !== 'string') : parts
    const kind = typeof type === 'string' ? type : kinds.join(' | ') || 'string'

    const always = required.has(name) && fallback === undefined

    return {
      name,
      type: typeof format === 'string' ? `${kind} (${format})` : kind,
      required: production === true ? 'production' : always && 'always',
      ...fallback !== undefined && { default: fallback },
      ...typeof description === 'string' && { description },
      ...secret === true && { secret: true as const },
      ...isPublic === true && { public: true as const },
    }
  })
}

// Names a variable meant for the server alone goes by, which no visitor should read: a map or analytics key is public by design, a secret, a token, an API key or a database address never is.
const SERVER_ONLY = /SECRET|PASSWORD|PASSWD|PRIVATE|TOKEN|(?:^|_)API_?KEY$|(?:^|_)(?:DATABASE|DB|POSTGRES|PG|MYSQL|REDIS|MONGO(?:DB)?)_URL$/i

// Hands the browser the variables of `schema` marked `s.Public`, or all of them for the `publicEnv` of kay.config.ts: the server refuses a name meant for the server alone, and an island reads the values as `publicEnv` from `kay`.
// A variable the build could not read is left out here and throws where a page reads it.
function exposePublic(schema: EnvSchema, values: Record<string, unknown>, owner: string, all = false): void {
  const names = Object.entries(schema.properties).filter(([, field]) => all || (field as { public?: unknown }).public === true).map(([name]) => name)

  if (names.length === 0)
    return

  const exposed = names.filter(name => SERVER_ONLY.test(name) || (schema.properties[name] as { secret?: unknown }).secret === true)

  if (exposed.length > 0)
    throw new KayError('config-invalid', `kay: ${owner} declares ${exposed.join(', ')}, which every visitor reads from ${PUBLIC_ENV_PATH}; keep a secret in defineEnv without s.Public, read on the server alone`)

  const held = (globalThis as { [PUBLIC_ENV]?: Record<string, unknown> })[PUBLIC_ENV] ??= {}

  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(values, name)

    if (descriptor !== undefined && 'value' in descriptor && descriptor.value !== undefined)
      held[name] = descriptor.value
  }
}

// Reads the `publicEnv` of kay.config.ts as `defineEnv` reads the server's, and serves the module the browser loads with it and every `s.Public` field `defineEnv` has read.
// The boot claims its path before any build.
export function servePublicEnv(app: Elysia, schema: EnvSchema): void {
  if (Object.keys(schema.properties).length > 0)
    exposePublic(schema, defineEnv(schema) as Record<string, unknown>, 'publicEnv', true)

  let reply: ReturnType<typeof fixedReply> | undefined

  app.get(PUBLIC_ENV_PATH, async ({ request }) => (reply ??= fixedReply(publicEnvModule((globalThis as { [PUBLIC_ENV]?: Record<string, unknown> })[PUBLIC_ENV] ?? {}), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }))(request))
}

export function publicEnvModule(values: Record<string, unknown>): string {
  return `export default ${JSON.stringify(values).replaceAll('<', '\\u003c')}\n`
}
