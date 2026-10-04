import type { Static, TSchema } from 'elysia'
import process from 'node:process'
import { readFields } from './query'

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

  if ('refused' in read)
    throw new Error(`kay: the environment does not match its schema\n${[...read.refused].map(([name, message]) => `  ${name}: ${message}`).join('\n')}`)

  return read.value as Static<Schema>
}
