import type { LocaleState } from '../src/runtime/locale-state'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { s } from '../src/runtime/schema'
import { isRefusal, validate } from '../src/server/validate'
import { pages } from './shared-pages'

const ORIGIN = 'http://localhost'
const app = await (async () => new Elysia().use(await pages({ root: 'tests/fixtures/validate-inputs', prebuilt: false, config: { security: false, guards: { default: 'open' } } })))()

const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`${ORIGIN}${path}`, { headers }))

describe('the inputs of an API route', () => {
  it('drops the query params and headers the schema does not name, and refuses what it does', async () => {
    expect(await (await get('/api/inputs/query?a=1&utm=x')).json()).toEqual({ a: 1 })
    expect((await get('/api/inputs/query?a=x')).status).toBe(422)
    expect(await (await get('/api/inputs/headers', { 'x-a': 'v', 'x-other': 'w' })).json()).toEqual({ 'x-a': 'v' })
    expect((await get('/api/inputs/headers')).status).toBe(422)
  })

  it('reads a cookie by its value', async () => {
    expect((await get('/api/inputs/cookie', { cookie: 'token=abcd; other=1' })).status).toBe(200)
    expect((await get('/api/inputs/cookie', { cookie: 'token=a' })).status).toBe(422)
  })

  it('leaves the body to a handler of a route that declares none', async () => {
    const response = await app.handle(new Request(`${ORIGIN}/api/inputs/raw?a=2`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'you' }) }))

    expect(await response.json()).toEqual({ hello: 'you' })
  })

  it('leaves the body to a handler of a route that declares no input at all', async () => {
    const response = await app.handle(new Request(`${ORIGIN}/api/inputs/undeclared`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hello: 'you' }) }))

    expect(await response.json()).toEqual({ hello: 'you' })
  })

  it('drops the fields a form post does not name, and refuses them in JSON', async () => {
    const form = await app.handle(new Request(`${ORIGIN}/api/inputs/form`, { method: 'POST', body: new URLSearchParams({ name: 'a', go: 'Save' }) }))
    const json = await app.handle(new Request(`${ORIGIN}/api/inputs/form`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a', go: 'Save' }) }))

    expect(await form.json()).toEqual({ name: 'a' })
    expect(json.status).toBe(422)
  })
})

describe('a guard\'s schema beside the route\'s', () => {
  it('reads each schema from what was posted, a form as JSON', async () => {
    const form = await app.handle(new Request(`${ORIGIN}/api/inputs/both`, { method: 'POST', body: new URLSearchParams({ guarded: 'g', own: 'o' }) }))
    const json = await app.handle(new Request(`${ORIGIN}/api/inputs/both`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guarded: 'g', own: 'o' }) }))

    expect(form.status).toBe(200)
    expect(await form.json()).toEqual({ guarded: 'g', own: 'o' })
    expect(json.status).toBe(200)
  })
})

describe('validate in a locale', () => {
  const schema = s.object({ name: s.string({ min: 3 }) })
  const state = (messages: [string, string][]): LocaleState => ({ locale: 'fr', messages: new Map(messages), settings: { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false }, path: '/' })

  it('words a refusal in the locale given, and keeps the schema summary for one without the keys', async () => {
    const given = await validate(schema, { name: 'a' }, { source: 'json', locale: state([['kay.invalid.tooShort', 'Au moins {min} caractères']]) })
    const without = await validate(schema, { name: 'a' }, { source: 'json', locale: state([]) })

    expect(isRefusal(given) && given.errors[0]?.message).toBe('Au moins 3 caractères')
    expect(isRefusal(without) && without.errors[0]?.message).toBe('Expected string length greater or equal to 3')
  })
})
