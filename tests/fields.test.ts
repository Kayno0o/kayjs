import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { formInput } from '../src/runtime/form'
import { defineEnv } from '../src/server'
import { buildingWithoutEnv, publicEnvModule, servePublicEnv } from '../src/server/env'
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

  it('counts an empty variable as left out, as a `.env` line with nothing after the `=` means', () => {
    expect(defineEnv(schema, { DATABASE_URL: 'postgres://db', PORT: '', DEBUG: '' })).toEqual({ DATABASE_URL: 'postgres://db', PORT: 3000 })
    // Required and written empty is missing, not an empty secret that would pass.
    expect(() => defineEnv(schema, { DATABASE_URL: '' })).toThrow('DATABASE_URL: Property \'DATABASE_URL\' is missing')
  })

  it('leaves an empty optional out rather than reading it as a blank value, whatever its type', () => {
    const optional = t.Object({ USER: t.Optional(t.String()), DEBUG: t.Optional(t.Boolean()), HOSTS: t.Optional(t.Array(t.String())) })

    // The case a reader branching on `undefined` depends on: a mailer handed `''` would send an empty user instead of no auth at all.
    expect(defineEnv(optional, { USER: '', DEBUG: '', HOSTS: '' })).toEqual({})
    expect(defineEnv(t.Object({ USER: t.Optional(t.String({ default: 'z' })) }), { USER: '' })).toEqual({ USER: 'z' })
  })

  it('fills an empty variable\'s default and refuses it where the schema gives none, for a boolean and a list too', () => {
    expect(defineEnv(t.Object({ DEBUG: t.Boolean({ default: true }), HOSTS: t.Array(t.String(), { default: ['a'] }) }), { DEBUG: '', HOSTS: '' })).toEqual({ DEBUG: true, HOSTS: ['a'] })
    expect(() => defineEnv(t.Object({ DEBUG: t.Boolean() }), { DEBUG: '' })).toThrow('DEBUG: ')
    expect(() => defineEnv(t.Object({ HOSTS: t.Array(t.String()) }), { HOSTS: '' })).toThrow('HOSTS: ')
  })

  it('keeps a value of spaces, which only quoting makes', () => {
    expect(defineEnv(t.Object({ PREFIX: t.String() }), { PREFIX: ' ' })).toEqual({ PREFIX: ' ' })
  })

  it('leaves kay build alone over an empty required variable, as over a missing one', () => {
    buildingWithoutEnv()

    try {
      const env = defineEnv(schema, { DATABASE_URL: '', PORT: '' })

      expect(env.PORT).toBe(3000)
      expect(() => env.DATABASE_URL).toThrow('kay: DATABASE_URL does not match')
    }
    finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.building')]
    }
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

describe('servePublicEnv', () => {
  it('stops the boot naming a public variable missing, and serves only the declared ones', async () => {
    expect(() => servePublicEnv(new Elysia(), t.Object({ KAY_TEST_MISSING: t.String() }))).toThrow('KAY_TEST_MISSING')
    expect(publicEnvModule({ MAP_KEY: 'a</script>', ZOOM: 3 })).toBe('export default {"MAP_KEY":"a\\u003c/script>","ZOOM":3}\n')
  })
})

describe('formInput', () => {
  const schema = t.Object({ message: t.String({ maxLength: 10 }), name: t.Optional(t.String()) })

  it('reads a posted line break as the one character the textarea counted', () => {
    // A form posts CRLF for every line break, so ten characters typed arrive as eleven and a `maxLength` of ten would refuse them.
    expect(formInput(schema, { message: 'a\r\nb', name: 'x\r\n\r\ny' })).toEqual({ message: 'a\nb', name: 'x\n\ny' })
    expect(formInput(schema, { message: 'a\rb' })).toEqual({ message: 'a\nb' })
    expect((formInput(schema, { message: '1234\r\n5678' }) as { message: string }).message).toHaveLength(9)
  })

  it('drops the spaces around what was typed and reads an optional field left blank as left out, a password and a field saying so kept as typed', () => {
    const fields = t.Object({ name: t.String({ minLength: 2 }), note: t.Optional(t.String()), tags: t.Array(t.String()), password: t.String(), code: t.Optional(t.String({ trim: false })) })

    expect(formInput(fields, { name: '  Ada \r\n', note: '   ', tags: [' a', 'b '], password: ' secret ', code: '  indented' })).toEqual({ name: 'Ada', tags: ['a', 'b'], password: ' secret ', code: '  indented' })
    expect(formInput(fields, { name: 'Ada', note: '', tags: [], password: 'x', code: '' })).toEqual({ name: 'Ada', tags: [], password: 'x' })
    // Not a form: a variable keeps the spaces it was given, and a blank plain string.
    expect(formInput(fields, { name: ' Ada ', note: '', tags: [], password: 'x' }, false)).toEqual({ name: ' Ada ', note: '', tags: [], password: 'x' })
  })

  it('leaves text without a line break as it is', () => {
    expect(formInput(schema, { message: 'plain', name: 'Ada' })).toEqual({ message: 'plain', name: 'Ada' })
  })
})

describe('readQuery', () => {
  const query = (search: string, schema?: unknown) => readQuery(schema, new URL(`http://localhost/${search}`))

  it('reads each parameter as text, a repeated one as a list, whatever its name', () => {
    expect(query('?a=1&b=x&b=y&constructor=c&__proto__=p&__proto__=q')).toEqual((Object.fromEntries([['a', '1'], ['b', ['x', 'y']], ['constructor', 'c'], ['__proto__', ['p', 'q']]])) as Readonly<Record<string, unknown>>)
  })

  it('fills defaults, a boolean or list one included, reads unticked checkboxes as false and decodes dates', () => {
    const search = t.Object({ exact: t.Boolean(), live: t.Boolean({ default: true }), tags: t.Array(t.String(), { default: ['all'] }), since: t.Optional(t.Date()) })

    expect(query('?since=2020-01-02', search)).toEqual({ exact: false, live: true, tags: ['all'], since: new Date('2020-01-02') })
  })

  it('denies a query its schema refuses with 400', () => {
    expect(() => query('?n=x', t.Object({ n: t.Integer() }))).toThrow(Denied)
  })
})
