import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { defineEnv } from '../src/server'
import { buildingWithoutEnv } from '../src/server/env'
import { readQuery } from '../src/server/query'
import { Denied } from '../src/server/signals'

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

  it('counts a variable written with no value as left out, as a `.env` line with nothing after the `=` means', () => {
    expect(defineEnv(schema, { DATABASE_URL: 'postgres://db', PORT: '', DEBUG: '' })).toEqual({ DATABASE_URL: 'postgres://db', PORT: 3000 })
    // Required and written empty is missing, not an empty secret that would pass.
    expect(() => defineEnv(schema, { DATABASE_URL: '' })).toThrow('DATABASE_URL: Property \'DATABASE_URL\' is missing')
  })

  it('names every variable missing or refused in the error that stops the boot', () => {
    expect(() => defineEnv(schema, { PORT: '80a' })).toThrow(new Error('kay: the environment does not match its schema\n  DATABASE_URL: Property \'DATABASE_URL\' is missing\n  PORT: Property \'PORT\' should be one of: \'integer\', \'integer\''))
  })

  it('refuses a required boolean or list left out, unless the schema gives it a default', () => {
    expect(() => defineEnv(t.Object({ DEBUG: t.Boolean(), HOSTS: t.Array(t.String()) }), {})).toThrow('DEBUG: ')
    expect(defineEnv(t.Object({ DEBUG: t.Boolean({ default: true }), HOSTS: t.Array(t.String(), { default: ['a'] }) }), {})).toEqual({ DEBUG: true, HOSTS: ['a'] })
  })

  it('lets kay build go on without a variable, a read of it failing instead', () => {
    buildingWithoutEnv()

    try {
      const env = defineEnv(schema, { PORT: '80a', DEBUG: 'true' })

      expect(env.DEBUG).toBe(true)
      expect(defineEnv(schema, {}).PORT).toBe(3000)
      expect(() => env.DATABASE_URL).toThrow('kay: DATABASE_URL does not match the environment\'s schema (Property \'DATABASE_URL\' is missing), and kay build runs without the server\'s environment')
      expect(() => env.PORT).toThrow('kay: PORT does not match')
    }
    finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.building')]
    }

    expect(() => defineEnv(schema, {})).toThrow('kay: the environment does not match its schema')
  })
})

describe('readQuery', () => {
  const query = (search: string, schema?: unknown) => readQuery(schema, new URL(`http://localhost/${search}`))

  it('reads each parameter as text, a repeated one as a list, whatever its name', () => {
    expect(query('?a=1&b=x&b=y&constructor=c&__proto__=p&__proto__=q')).toEqual(Object.fromEntries([['a', '1'], ['b', ['x', 'y']], ['constructor', 'c'], ['__proto__', ['p', 'q']]]))
  })

  it('fills defaults, a boolean or list one included, reads unticked checkboxes as false and decodes dates', () => {
    const search = t.Object({ exact: t.Boolean(), live: t.Boolean({ default: true }), tags: t.Array(t.String(), { default: ['all'] }), since: t.Optional(t.Date()) })

    expect(query('?since=2020-01-02', search)).toEqual({ exact: false, live: true, tags: ['all'], since: new Date('2020-01-02') })
  })

  it('denies a query its schema refuses with 400', () => {
    expect(() => query('?n=x', t.Object({ n: t.Integer() }))).toThrow(Denied)
  })
})
