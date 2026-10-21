import type { FieldSchema } from '../src/runtime/form'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { PUBLIC_ENV } from '../src/runtime/env'
import { formInput, nativeConstraints } from '../src/runtime/form'
import { readParam } from '../src/runtime/query-param'
import { s } from '../src/runtime/schema'
import { defineEnv } from '../src/server'
import { publicEnvModule, servePublicEnv } from '../src/server/env'
import { buildingWithoutEnv } from '../src/server/env-state'
import { queryRules, queryScript, readQuery } from '../src/server/query'
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

  it('words a refusal with a function error as with a string', () => {
    const worded = t.Object({ PORT: t.Numeric({ error: () => 'the port is a number' }) })

    expect(() => defineEnv(worded, { PORT: 'x' })).toThrow('PORT: the port is a number')
  })

  describe('a variable left out or written empty', () => {
    const optional = t.Object({ USER: t.Optional(t.String()), DEBUG: t.Optional(t.Boolean()), HOSTS: t.Optional(t.Array(t.String())) })
    const defaulted = t.Object({ DEBUG: t.Boolean({ default: true }), HOSTS: t.Array(t.String(), { default: ['a'] }) })
    const required = t.Object({ DEBUG: t.Boolean(), HOSTS: t.Array(t.String()) })

    it.each([
      // The case a reader branching on `undefined` depends on: a mailer handed `''` would send an empty user instead of no auth at all.
      ['leaves an empty optional out, whatever its type', optional, { USER: '', DEBUG: '', HOSTS: '' }, {}],
      ['gives an empty optional its default', t.Object({ USER: t.Optional(t.String({ default: 'z' })) }), { USER: '' }, { USER: 'z' }],
      ['fills an empty boolean and list with their defaults', defaulted, { DEBUG: '', HOSTS: '' }, { DEBUG: true, HOSTS: ['a'] }],
      ['fills a boolean and list left out with their defaults', defaulted, {}, { DEBUG: true, HOSTS: ['a'] }],
      ['keeps a value of spaces, which only quoting makes', t.Object({ PREFIX: t.String() }), { PREFIX: ' ' }, { PREFIX: ' ' }],
    ])('%s', (_name, schema, env, expected) => {
      expect(defineEnv(schema, env)).toEqual(expected)
    })

    it.each([
      ['an empty required boolean', t.Object({ DEBUG: t.Boolean() }), { DEBUG: '' }, 'DEBUG: '],
      ['an empty required list', t.Object({ HOSTS: t.Array(t.String()) }), { HOSTS: '' }, 'HOSTS: '],
      ['a required boolean and list left out', required, {}, 'DEBUG: '],
    ])('refuses %s', (_name, schema, env, message) => {
      expect(() => defineEnv(schema, env)).toThrow(message)
    })
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
    expect(() => defineEnv(schema, { PORT: '80a' })).toThrow(new Error('kay: the environment does not match its schema\n  DATABASE_URL: Property \'DATABASE_URL\' is missing\n  PORT: Property \'PORT\' should be one of: \'integer\''))
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

  it('refuses to boot with a variable named as a secret, a token, an API key or a database address', () => {
    const names = ['KAY_TEST_STRIPE_SECRET', 'KAY_TEST_ACCESS_TOKEN', 'KAY_TEST_TOKEN_HASH', 'KAY_TEST_API_KEY', 'KAY_TEST_STRIPE_API_KEY', 'API_KEY', 'KAY_TEST_APIKEY', 'KAY_TEST_DATABASE_URL']

    Object.assign(process.env, { KAY_TEST_MAP_KEY: 'pk', ...Object.fromEntries(names.map(name => [name, 'sk'])) })

    try {
      expect(() => servePublicEnv(new Elysia(), t.Object({ KAY_TEST_MAP_KEY: t.String() }))).not.toThrow()

      for (const name of names)
        expect(() => servePublicEnv(new Elysia(), t.Object({ KAY_TEST_MAP_KEY: t.String(), [name]: t.String() })), name).toThrow(`kay: publicEnv declares ${name}, which every visitor reads`)
    }
    finally {
      for (const name of ['KAY_TEST_MAP_KEY', ...names])
        delete process.env[name]
    }
  })
})

describe('s.Public', () => {
  it('hands the browser the public fields of defineEnv alone, served from the env module', async () => {
    const held = globalThis as { [PUBLIC_ENV]?: Record<string, unknown> | undefined }
    const before = held[PUBLIC_ENV]

    held[PUBLIC_ENV] = undefined

    try {
      const env = defineEnv(s.Object({ KAY_TEST_MAP_KEY: s.Public(s.String()), KAY_TEST_ZOOM: s.Public(s.Optional(s.Integer({ default: 3 }))), KAY_TEST_HIDDEN: s.String() }), { KAY_TEST_MAP_KEY: 'pk', KAY_TEST_HIDDEN: 'x' })

      expect(env.KAY_TEST_HIDDEN).toBe('x')
      const response = await servePublicApp().handle(new Request('http://localhost/_kay/env.js'))

      expect({ ...(globalThis as Record<symbol, object>)[PUBLIC_ENV] }).toEqual({ KAY_TEST_MAP_KEY: 'pk', KAY_TEST_ZOOM: 3 })

      expect(await response.text()).toBe('export default {"KAY_TEST_MAP_KEY":"pk","KAY_TEST_ZOOM":3}\n')
    }
    finally {
      held[PUBLIC_ENV] = before
    }
  })

  it('refuses a public field named as a secret, a token or a database address, and a secret one', () => {
    for (const name of ['KAY_TEST_STRIPE_SECRET', 'KAY_TEST_ACCESS_TOKEN', 'KAY_TEST_API_KEY', 'KAY_TEST_DATABASE_URL'])
      expect(() => defineEnv(s.Object({ [name]: s.Public(s.String()) }), { [name]: 'v' }), name).toThrow(`kay: s.Public declares ${name}, which every visitor reads`)

    expect(() => defineEnv(s.Object({ KAY_TEST_MAP_KEY: s.Public(s.Secret()) }), { NODE_ENV: 'test' })).toThrow('kay: s.Public declares KAY_TEST_MAP_KEY')
  })

  it('serves the values of the modules each boot names, not those another boot of the process left', async () => {
    defineEnv(s.Object({ KAY_TEST_BOOT_ONE: s.Public(s.String()) }), { KAY_TEST_BOOT_ONE: 'one' })

    const own = new Elysia()
    const other = new Elysia()

    servePublicEnv(own, t.Object({}), [import.meta.path])
    expect({ ...(globalThis as Record<symbol, object>)[PUBLIC_ENV] }).toMatchObject({ KAY_TEST_BOOT_ONE: 'one' })
    servePublicEnv(other, t.Object({}), ['/elsewhere/src/env.ts'])
    expect({ ...(globalThis as Record<symbol, object>)[PUBLIC_ENV] }).toEqual({})
    expect(await (await other.handle(new Request('http://localhost/_kay/env.js'))).text()).toBe('export default {}\n')
    expect(await (await own.handle(new Request('http://localhost/_kay/env.js'))).text()).toContain('"KAY_TEST_BOOT_ONE":"one"')
  })

  it('forgets what the build could not read once another boot does not name its module', async () => {
    buildingWithoutEnv()

    try {
      defineEnv(s.Object({ KAY_TEST_UNREAD_PUBLIC: s.Public(s.String()) }), {})
    }
    finally {
      ;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.building')] = undefined
    }

    const own = new Elysia()
    const other = new Elysia()

    servePublicEnv(own, t.Object({}), [import.meta.path])
    servePublicEnv(other, t.Object({}), [])
    expect((await own.handle(new Request('http://localhost/_kay/env.js'))).status).toBe(500)
    expect((await other.handle(new Request('http://localhost/_kay/env.js'))).status).toBe(200)
  })

  it('leaves a public field the build could not read out, as the page reading it throws, and fails the browser module', async () => {
    buildingWithoutEnv()

    try {
      const env = defineEnv(s.Object({ KAY_TEST_MISSING_PUBLIC: s.Public(s.String()) }), {})

      expect(() => env.KAY_TEST_MISSING_PUBLIC).toThrow('KAY_TEST_MISSING_PUBLIC')
      expect((await servePublicApp().handle(new Request('http://localhost/_kay/env.js'))).status).toBe(500)
    }
    finally {
      ;(globalThis as Record<symbol, unknown>)[Symbol.for('kay.building')] = undefined
    }
  })
})

function servePublicApp(): Elysia {
  const app = new Elysia()

  servePublicEnv(app, t.Object({}), [import.meta.path])

  return app
}

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

describe('nativeConstraints', () => {
  const of = (field: unknown, required = true) => Object.fromEntries(nativeConstraints(field as FieldSchema, required))

  it('requires only a field the server would refuse left blank', () => {
    expect(of(t.String())).toEqual({})
    expect(of(t.String({ minLength: 1 }))).toEqual({ required: '', minlength: '1' })
    expect(of(t.String({ minLength: 1 }), false)).toEqual({ minlength: '1' })
    expect(of(t.Integer())).toEqual({ required: '' })
    expect(of(t.Boolean())).toEqual({})
    expect(of(t.Array(t.String()))).toEqual({})
    expect(of(t.File())).toEqual({ required: '' })
    expect(of(t.Union([t.Literal('a'), t.Literal('b')]))).toEqual({ required: '' })
    expect(of(t.Union([t.Literal(''), t.Literal('b')]))).toEqual({})
  })

  it('anchors a pattern the schema matches anywhere, and drops one the browser\'s v flag cannot read', () => {
    expect(of(t.String({ pattern: '^[a-z]+$' }))).toEqual({ required: '', pattern: '^[a-z]+$' })
    expect(of(t.String({ pattern: '\\d' }))).toEqual({ required: '', pattern: '[\\s\\S]*(?:\\d)[\\s\\S]*' })
    expect(of(t.String({ pattern: '^[\\w-]*$' }))).toEqual({})
  })

  it('bounds a number, s.Numeric included, and types an email field', () => {
    expect(of(t.Numeric({ minimum: 1, maximum: 9 }), false)).toEqual({ min: '1', max: '9' })
    expect(of(t.String({ format: 'email', maxLength: 80 }))).toEqual({ required: '', maxlength: '80', type: 'email' })
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

  it('leaves out the words a search hit\'s link carries, so a strict schema does not refuse the page', () => {
    const strict = t.Object({ n: t.Optional(t.Integer()) }, { additionalProperties: false })

    expect(query('?kay_q=install+it&n=2', strict)).toEqual({ n: 2 })
    expect(query('?kay_q=x')).toEqual({})
  })

  it('denies a query its schema refuses with 400', () => {
    expect(() => query('?n=x', t.Object({ n: t.Integer() }))).toThrow(Denied)
  })

  it('names a refused field holding a slash or a tilde by its own name', () => {
    const message = (search: string) => {
      try {
        query(search, t.Object({ 'a/b': t.Integer(), 'c~d': t.Integer() }))
      }
      catch (error) {
        return (error as Denied).message
      }

      return undefined
    }

    expect(message('?a%2Fb=x&c~d=1')).toStartWith('Invalid query: a/b: ')
    expect(message('?a%2Fb=1&c~d=x')).toStartWith('Invalid query: c~d: ')
  })

  it('words a refusal with the field\'s error function as with a string, and keeps the default wording for one that throws', () => {
    const message = (search: string, schema: unknown) => {
      try {
        query(search, schema)
      }
      catch (error) {
        return (error as Denied).message
      }

      return undefined
    }

    expect(message('?page=x', t.Object({ page: t.Integer({ error: () => 'the page is a number' }) }))).toBe('Invalid query: page: the page is a number')
    expect(message('?page=x', t.Object({ page: t.Integer({ error: 'a number please' }) }))).toBe('Invalid query: page: a number please')
    expect(message('?page=x', t.Object({ page: t.Integer({ error: () => {
      throw new Error('boom')
    } }) }))).toStartWith('Invalid query: page: ')
    expect(message('?page=x', t.Object({ page: t.Integer({ error: () => {
      throw new Error('boom')
    } }) }))).not.toContain('boom')
  })
})

describe('readParam', () => {
  const rules = queryRules(t.Object({
    page: t.Integer({ minimum: 1, default: 1 }),
    tags: t.Array(t.String(), { default: [] }),
    view: t.UnionEnum(['grid', 'list'], { default: 'grid' }),
    exact: t.Boolean(),
    near: t.Optional(t.Numeric()),
    sort: t.Union([t.Literal('new'), t.Literal('old')], { default: 'new' }),
  }))
  const param = (name: string, search: string) => readParam(rules, name, new URLSearchParams(search))

  it('reads a param as the page\'s schema does, through rules that hold no TypeBox', () => {
    expect(JSON.parse(JSON.stringify(rules))).toEqual(rules!)
    expect([param('page', 'page=3'), param('tags', 'tags=a&tags=b'), param('view', 'view=list'), param('exact', 'exact=on'), param('near', 'near=2.5'), param('sort', 'sort=old')]).toEqual([3, ['a', 'b'], 'list', true, 2.5, 'old'])
  })

  it('reads a param left out as its default, an unticked checkbox as false', () => {
    expect([param('page', ''), param('tags', ''), param('view', ''), param('exact', ''), param('near', '')]).toEqual([1, [], 'grid', false, undefined])
  })

  it('reads a param the schema refuses as its default rather than throwing', () => {
    expect([param('page', 'page=x'), param('page', 'page=0'), param('page', 'page=1.5'), param('view', 'view=table'), param('near', 'near=far'), param('sort', 'sort=top'), param('tags', 'tags=a&tags=')]).toEqual([1, 1, 1, 'grid', undefined, 'new', ['a', '']])
  })

  it('reads a param no rule names, or every param of a page without a schema, as its text', () => {
    expect([param('q', 'q=kay'), readParam(undefined, 'page', new URLSearchParams('page=3'))]).toEqual(['kay', '3'])
  })

  it('writes the rules into a script no text in them closes', () => {
    expect(queryScript(queryRules(t.Object({ q: t.String({ default: '</script>' }) })))).toBe('<script type="application/json" data-kay-query>{"q":{"type":"string","default":"\\u003c/script>","required":true}}</script>')
    expect(queryScript(queryRules(undefined))).toBe('')
  })
})
