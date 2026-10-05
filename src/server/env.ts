import type { Elysia, Static, TSchema } from 'elysia'
import process from 'node:process'
import { t } from 'elysia'
import { PUBLIC_ENV } from '../runtime/env'
import { readFields } from './query'

// A `t.Object` of the variables, each read on its own.
export type EnvSchema = TSchema & { properties: Record<string, TSchema> }

// On the global object, so a copy of kay the app loads beside the CLI's sees it too.
const BUILDING = Symbol.for('kay.building')

// `kay build` renders pages, and `kay check` reads content and messages, without the server's environment: from then on a variable missing or refused fails the page reading it rather than the module declaring it.
export function buildingWithoutEnv(): void {
  (globalThis as { [BUILDING]?: boolean })[BUILDING] = true
}

function building(): boolean {
  return (globalThis as { [BUILDING]?: boolean })[BUILDING] === true
}

// The environment read once against `schema`, as the server boots: numbers and booleans from their text, defaults filled in, and every variable missing or refused named in the error that stops it.
// Holds the declared names only, so logging it never shows the rest of the environment.
export function defineEnv<Schema extends EnvSchema>(schema: Schema, source: Record<string, string | undefined> = process.env): Static<Schema> {
  const input: Record<string, string> = {}

  for (const name of Object.keys(schema.properties)) {
    const value = source[name]

    // An empty variable is how a `.env` file says it is not set, so the default or `t.Optional` applies rather than `''` failing the schema; nothing tells `KEY=` from `KEY=""` by the time it is read.
    if (value !== undefined && value !== '')
      input[name] = value
  }

  const read = readFields(schema, input, false)

  if (!('refused' in read))
    return read.value as Static<Schema>

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

  return env as Static<Schema>
}

// The module the island entry imports the public variables from, served from the environment the server runs in, so an executable or a prerendered page reads today's values rather than those of the build.
export const PUBLIC_ENV_PATH = '/_kay/env.js'

// Reads the public variables as `defineEnv` reads the server's, for `publicEnv` on the server and the module the browser loads.
export function servePublicEnv(app: Elysia, schema: EnvSchema): void {
  const values = defineEnv(schema) as Record<string, unknown>

  ;(globalThis as { [PUBLIC_ENV]?: unknown })[PUBLIC_ENV] = values
  app.get(PUBLIC_ENV_PATH, () => new Response(publicEnvModule(values), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } }))
}

export function publicEnvModule(values: Record<string, unknown>): string {
  return `export default ${JSON.stringify(values).replaceAll('<', '\\u003c')}\n`
}
