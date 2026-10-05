import type { Static, TSchema } from 'elysia'
import process from 'node:process'
import { t } from 'elysia'
import { readFields } from './query'

// On the global object, so a copy of kay the app loads beside the CLI's sees it too.
const BUILDING = Symbol.for('kay.building')

// `kay build` renders pages without the server's environment: from then on a variable missing or refused fails the page reading it rather than the module declaring it.
export function buildingWithoutEnv(): void {
  (globalThis as { [BUILDING]?: boolean })[BUILDING] = true
}

// The environment read once against `schema`, as the server boots: numbers and booleans from their text, defaults filled in, and every variable missing or refused named in the error that stops it.
// Holds the declared names only, so logging it never shows the rest of the environment.
export function defineEnv<Schema extends TSchema & { properties: Record<string, TSchema> }>(schema: Schema, source: Record<string, string | undefined> = process.env): Static<Schema> {
  const input: Record<string, string> = {}

  for (const name of Object.keys(schema.properties)) {
    const value = source[name]

    if (value !== undefined)
      input[name] = value
  }

  const read = readFields(schema, input, false)

  if (!('refused' in read))
    return read.value as Static<Schema>

  if (!(globalThis as { [BUILDING]?: boolean })[BUILDING])
    throw new Error(`kay: the environment does not match its schema\n${[...read.refused].map(([name, message]) => `  ${name}: ${message}`).join('\n')}`)

  const valid = t.Object(Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !read.refused.has(name))))
  const env = (readFields(valid, input, false) as { value: Record<string, unknown> }).value

  for (const [name, message] of read.refused) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get: () => {
        throw new Error(`kay: ${name} does not match the environment's schema (${message}), and kay build renders pages without the server's environment; read it once the server runs, such as in an action, or drop \`export const prerender\` from the page reading it`)
      },
    })
  }

  return env as Static<Schema>
}
