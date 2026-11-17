import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { encodeValue } from '../src/runtime/wire'
import { pages } from './shared-pages'

const ORIGIN = 'http://localhost'
const ACTION = '/_kay/action/src/routes/index.kay'
const app = await (async () => new Elysia().use(await pages({ root: 'tests/fixtures/standard-schema', prebuilt: false, security: false, requireGuards: false })))()

const send = async (path: string, body: unknown, init: RequestInit = {}) => app.handle(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'origin': ORIGIN, 'referer': `${ORIGIN}/`, 'content-type': 'application/json' }, body: JSON.stringify(body), ...init }))

describe('a Standard Schema validator on an API route', () => {
  it('validates the JSON body through ~standard.validate and never coerces it', async () => {
    expect(await (await send('/api/people', { age: 3 })).json()).toEqual({ age: 3 })

    const refused = await send('/api/people', { age: '3' })

    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ status: 422, errors: { age: 'age is a whole number' } })
  })

  it('reads a text source by the JSON Schema it describes itself with', async () => {
    const response = await app.handle(new Request(`${ORIGIN}/api/people/query?age=4`))

    expect(await response.json()).toEqual({ age: 4 })
  })

  it('validates one that has no JSON Schema, which only a text source cannot read', async () => {
    expect((await send('/api/people/plain', { age: 5 })).status).toBe(200)
    expect((await send('/api/people/plain', { age: 'x' })).status).toBe(422)
  })

  it('describes the route in OpenAPI by its JSON Schema', async () => {
    const document = await (await app.handle(new Request(`${ORIGIN}/api/openapi.json`))).json() as { paths: Record<string, { post?: { requestBody?: { content: Record<string, { schema: unknown }> } } }> }

    expect(document.paths['/api/people']?.post?.requestBody?.content['application/json']?.schema).toEqual({ type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] })
  })
})

describe('a Standard Schema validator on an action', () => {
  it('runs the handler on a valid call and answers a refusal with the validator\'s message', async () => {
    const call = { headers: { 'origin': ORIGIN, 'referer': `${ORIGIN}/`, 'content-type': 'application/json', 'x-kay-action': '1' } }

    expect((await send(`${ACTION}/add`, undefined, { ...call, body: encodeValue({ age: 2 }) })).status).toBe(200)

    const refused = await send(`${ACTION}/add`, undefined, { ...call, body: encodeValue({ age: 'x' }) })

    expect(refused.status).toBe(422)
    expect(JSON.stringify(await refused.json())).toContain('age is a whole number')
  })

  it('reads a form post by the JSON Schema, and refuses what a validator without one cannot read', async () => {
    const form = async (name: string) => app.handle(new Request(`${ORIGIN}${ACTION}/${name}`, { method: 'POST', headers: { 'origin': ORIGIN, 'referer': `${ORIGIN}/`, 'x-kay-action': 'form' }, body: new URLSearchParams({ age: '7' }) }))

    expect((await form('add')).status).toBe(200)
    expect((await form('bare')).status).toBe(422)
  })
})
