import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { defineEnv } from '../src/server'

const schema = t.Object({
  DATABASE_URL: t.String({ minLength: 1 }),
  PORT: t.Integer({ default: 3000 }),
  DEBUG: t.Optional(t.Boolean()),
})

describe('defineEnv', () => {
  it('reads numbers and booleans from their text, fills defaults and keeps the declared names only', () => {
    expect(defineEnv(schema, { DATABASE_URL: 'postgres://db', DEBUG: 'true', PATH: '/bin' })).toEqual({ DATABASE_URL: 'postgres://db', PORT: 3000, DEBUG: true })
    expect(defineEnv(schema, { DATABASE_URL: 'postgres://db', PORT: '8080', DEBUG: '' }).PORT).toBe(8080)
  })

  it('names every variable missing or refused in the error that stops the boot', () => {
    expect(() => defineEnv(schema, { PORT: '80a' })).toThrow(new Error('kay: the environment does not match its schema\n  DATABASE_URL: Property \'DATABASE_URL\' is missing\n  PORT: Property \'PORT\' should be one of: \'integer\', \'integer\''))
  })
})
