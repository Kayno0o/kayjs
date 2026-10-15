import type { Elysia, Static, TSchema } from 'elysia'
import type { ServedPaths } from './served-paths'
import process from 'node:process'
import { t } from 'elysia'
import { PUBLIC_ENV } from '../runtime/env'
import { kayLog } from '../runtime/log'
import { fixedReply } from './compress'
import { building, PUBLIC_ENV_PATH } from './env-state'
import { readFields } from './query'

// A `s.Object` of the variables, each read on its own.
export type EnvSchema = TSchema & { properties: Record<string, TSchema> }

// The environment read once against `schema`, as the server boots: numbers and booleans from their text, defaults filled in, and every variable missing or refused named in the error that stops it.
// Holds the declared names only, so logging it never shows the rest of the environment.
export function defineEnv<Schema extends EnvSchema>(schema: Schema, source: Record<string, string | undefined> = process.env): Static<Schema> {
  const input: Record<string, string> = {}

  for (const name of Object.keys(schema.properties)) {
    const value = source[name]

    // An empty variable is how a `.env` file says it is not set, so the default or `s.Optional` applies rather than `''` failing the schema; nothing tells `KEY=` from `KEY=""` by the time it is read.
    if (value !== undefined && value !== '')
      input[name] = value
  }

  const read = readFields(schema, input, false)

  if (!('refused' in read))
    return read.value

  if (!building())
    throw new Error(`kay: the environment does not match its schema\n${[...read.refused].map(([name, message]) => `  ${name}: ${message}`).join('\n')}`)

  // The variables the build has, read on their own; a refusal of the whole object, named '', is left to the server.
  const valid = t.Object(Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !read.refused.has(name))))
  const env = (readFields(valid, input, false) as { value: Record<string, unknown> }).value

  for (const [name, message] of read.refused) {
    if (name === '')
      continue

    Object.defineProperty(env, name, {
      enumerable: true,
      get: () => {
        throw new Error(`kay: ${name} does not match the environment's schema (${message}), and kay build runs without the server's environment; read it where the server runs, such as in an action, or leave the page reading it out of the build`)
      },
    })
  }

  return env
}

// Names a variable meant for the server alone goes by, which no visitor should read: a map or analytics key is public by design, a secret or a database address never is.
const SERVER_ONLY = /SECRET|PASSWORD|PASSWD|PRIVATE|(?:^|_)(?:DATABASE|DB|POSTGRES|PG|MYSQL|REDIS|MONGO(?:DB)?)_URL$/i

// Reads the public variables as `defineEnv` reads the server's, for `publicEnv` on the server and the module the browser loads.
export function servePublicEnv(app: Elysia, served: ServedPaths, schema: EnvSchema): void {
  served.claim({ path: PUBLIC_ENV_PATH, owner: '`publicEnv`', kind: 'kay', exported: true })

  const values = defineEnv(schema) as Record<string, unknown>
  const exposed = Object.keys(values).filter(name => SERVER_ONLY.test(name))

  if (exposed.length > 0)
    kayLog('warn', `publicEnv declares ${exposed.join(', ')}, which every visitor reads from ${PUBLIC_ENV_PATH}; keep a secret in defineEnv, read on the server alone`)

  ;(globalThis as { [PUBLIC_ENV]?: unknown })[PUBLIC_ENV] = values

  let reply: ReturnType<typeof fixedReply> | undefined

  app.get(PUBLIC_ENV_PATH, async ({ request }) => (reply ??= fixedReply(publicEnvModule(values), { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }))(request))
}

export function publicEnvModule(values: Record<string, unknown>): string {
  return `export default ${JSON.stringify(values).replaceAll('<', '\\u003c')}\n`
}
