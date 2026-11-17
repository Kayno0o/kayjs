import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { s as serverS } from '../src/runtime/schema'
import { schemaOf } from '../src/runtime/schema-record'
import { s as browserS } from '../src/runtime/schema.client'
import { validate as browserValidate } from '../src/runtime/validate.client'
import { validate as serverValidate } from '../src/server/validate'

type Builders = typeof serverS

// The same schema built by each side's `s`, so what the browser refuses is checked against what the server refuses.
const shapes: Record<string, (s: Builders) => object> = {
  record: s => ({ email: s.email(), topic: s.enum(['a', 'b']), message: s.string({ min: 3, max: 10, error: { min: 'Say more' } }), age: s.int({ min: 18, optional: true }), tags: s.list(s.string(), { max: 2 }), site: s.url({ optional: true }) }),
  nested: s => s.object({ user: s.object({ name: s.string({ min: 1 }), role: s.enum({ admin: 'Admin', member: 'Member' }) }), flags: s.record(s.boolean()) }),
  union: s => ({ pick: s.union([s.literal('x'), s.int({ min: 1 })]) }),
}

const values: Record<string, unknown[]> = {
  record: [
    { email: 'a@b.fr', topic: 'a', message: 'hello', tags: [] },
    { email: 'nope', topic: 'c', message: 'hi', age: 3, tags: ['a', 'b', 'c'], site: 'ftp://x' },
    { email: 'a@b.fr', topic: 'a', message: 'hello', tags: [], extra: 1 },
    { topic: 'a' },
  ],
  nested: [
    { user: { name: 'Ann', role: 'admin' }, flags: { a: true } },
    { user: { name: '', role: 'boss' }, flags: { a: 'yes' } },
    { user: { role: 'admin' } },
  ],
  union: [{ pick: 'x' }, { pick: 5 }, { pick: 0 }, { pick: 'y' }, {}],
}

describe('validate in the browser', () => {
  beforeAll(() => GlobalRegistrator.register())
  afterAll(async () => GlobalRegistrator.unregister())

  for (const [name, build] of Object.entries(shapes)) {
    it(`refuses ${name} values as the server does`, async () => {
      for (const value of values[name]!) {
        const server = await serverValidate(schemaOf(build(serverS) as never), value, { source: 'json' })
        const browser = await browserValidate(build(browserS), value, { source: 'json' })

        expect('errors' in browser).toBe('errors' in server)

        if ('errors' in browser && 'errors' in server) {
          expect(browser.errors.map(({ path }) => path).toSorted()).toEqual(server.errors.map(({ path }) => path).toSorted())
          expect(browser.status).toBe(422)
        }
      }
    })
  }

  it('words a refusal with the field\'s error record', async () => {
    const result = await browserValidate({ message: browserS.string({ min: 3, error: { min: 'Say more' } }) }, { message: 'hi' }, { source: 'json' })

    expect(result).toEqual({ errors: [{ path: 'message', key: 'kay.invalid.tooShort', params: { min: 3 }, message: 'Say more' }], status: 422 })
  })

  it('reads form text as numbers, booleans and lists, and drops unknown fields, but never coerces JSON', async () => {
    const schema = { n: browserS.int(), ok: browserS.boolean(), tags: browserS.list(browserS.string()) }

    expect(await browserValidate(schema, { n: '3', ok: 'on', tags: 'a', stray: 'x' }, { source: 'form' })).toEqual({ value: { n: 3, ok: true, tags: ['a'] } })
    expect('errors' in await browserValidate(schema, { n: '3', ok: true, tags: [] }, { source: 'json' })).toBe(true)
  })

  it('refuses an unknown key in JSON and a bound a default adds', async () => {
    expect('errors' in await browserValidate({ a: browserS.string() }, { a: 'x', b: 1 }, { source: 'json' })).toBe(true)
    expect('errors' in await browserValidate({ a: browserS.string() }, { a: 'x'.repeat(10_001) }, { source: 'json' })).toBe(true)
  })

  it('fills a default and validates through a Standard Schema validator', async () => {
    expect(await browserValidate({ a: browserS.string({ default: 'x' }) }, {}, { source: 'json' })).toEqual({ value: { a: 'x' } })

    const standard = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => typeof value === 'string' ? { value } : { issues: [{ message: 'Text please', path: ['a'] }] } } }

    expect(await browserValidate(standard, 3, { source: 'json' })).toEqual({ errors: [{ path: 'a', key: 'kay.invalid.type', params: {}, message: 'Text please' }], status: 422 })
  })
})
