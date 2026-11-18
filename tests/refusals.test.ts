import type { ActionStream } from '../src/runtime'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { ActionError, readActionResponse } from '../src/runtime/action'
import { refuse, thrownRefusal } from '../src/runtime/refuse'
import { decodeServerValue, encodeValue } from '../src/runtime/wire'
import { pages } from './shared-pages'

const ORIGIN = 'http://localhost'
const ACTION = '/_kay/action/src/routes/index.kay'

let served: Promise<Elysia> | undefined

async function app(): Promise<Elysia> {
  served ??= (async () => new Elysia().use(await pages({ root: 'tests/fixtures/refusals', prebuilt: false, security: false, guards: { default: 'open' } })))()

  return served
}

// A form post, which a failure answers with the page it came from; a call made with a form, which answers `{ errors, data }`.
async function post(name: string, fields: Record<string, string> = {}, call = false): Promise<Response> {
  return (await app()).handle(new Request(`${ORIGIN}${ACTION}/${name}`, { method: 'POST', headers: { origin: ORIGIN, referer: `${ORIGIN}/`, ...call && { 'x-kay-action': 'form' } }, body: new URLSearchParams(fields) }))
}

function thrown(run: () => never) {
  try {
    run()
  }
  catch (error) {
    return thrownRefusal(error)
  }

  return undefined
}

describe('refuse', () => {
  it('takes the status first and the message, errors and data in one object', () => {
    expect(thrown(() => refuse(409, { message: 'Over', errors: { name: 'taken' }, data: 7 }))).toMatchObject({ status: 409, message: 'Over', errors: { name: 'taken' }, data: 7 })
    expect(thrown(() => refuse(429))).toMatchObject({ status: 429, message: 'Refused', errors: {} })
    expect(thrown(() => refuse())).toMatchObject({ status: 403, message: 'Refused' })
  })

  it('refuses a status outside 400 to 599', () => {
    expect(() => refuse(200)).toThrow(expect.objectContaining({ code: 'argument-invalid' }))
    expect(() => refuse(302)).toThrow(expect.objectContaining({ code: 'argument-invalid' }))
  })
})

describe('ctx.deny in an action', () => {
  it('fails the post with the message, the fields and the data', async () => {
    const response = await post('refused', { status: '409' }, true)

    expect(response.status).toBe(409)
    expect(decodeServerValue(await response.text())).toMatchObject({ errors: { '': 'Taken', 'name': 'Already taken' }, data: { row: 7 } })
  })

  it('answers a form post with the page again, under the status', async () => {
    const response = await post('refused', { status: '422' })

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('stops with plain text when it carries nothing', async () => {
    const bare = await post('bare', {}, true)

    expect([bare.status, await bare.text()]).toEqual([409, 'Conflict'])
  })

  it('refuses with the message alone as a failure of the form, for a call, an island call and a form post', async () => {
    const form = await post('messageOnly', {}, true)
    const island = await (await app()).handle(new Request(`${ORIGIN}${ACTION}/messageOnly`, { method: 'POST', headers: { 'origin': ORIGIN, 'x-kay-action': '1', 'content-type': 'application/json' }, body: encodeValue({}) }))
    const page = await post('messageOnly')

    expect(form.status).toBe(403)
    expect(decodeServerValue(await form.text())).toEqual({ errors: { '': 'Members only' }, data: undefined })
    expect(island.status).toBe(403)
    expect(decodeServerValue(await island.text())).toMatchObject({ errors: { '': 'Members only' } })
    expect(page.status).toBe(403)
    expect(page.headers.get('content-type')).toContain('text/html')
  })

  it('fails the form with the message of a helper given the action context, the retry-after header kept', async () => {
    const response = await post('limited', {}, true)

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).not.toBeNull()
    expect((decodeServerValue(await response.text()) as { errors: Record<string, string> }).errors['']).toMatch(/\S/)
  })

  it('reaches an island call as an ActionError carrying the message', async () => {
    const response = await (await app()).handle(new Request(`${ORIGIN}${ACTION}/messageOnly`, { method: 'POST', headers: { 'origin': ORIGIN, 'x-kay-action': '1', 'content-type': 'application/json' }, body: encodeValue({}) }))
    const failure = readActionResponse(response, `${ACTION}/messageOnly`)

    await expect(failure).rejects.toBeInstanceOf(ActionError)
    await expect(failure).rejects.toMatchObject({ status: 403, message: 'Members only' })
  })

  it('answers a stream denying before its first value as a failure, and one denying after it as a failed stream', async () => {
    const call = async (name: string) => (await app()).handle(new Request(`${ORIGIN}${ACTION}/${name}`, { method: 'POST', headers: { 'origin': ORIGIN, 'x-kay-action': '1', 'content-type': 'application/json' }, body: encodeValue({}) }))
    const first = await call('streamedFirst')
    const midway = await call('streamed')

    expect(first.status).toBe(409)
    expect(await first.text()).toContain('Stopped before')
    expect(midway.status).toBe(200)
    expect(midway.headers.get('content-type')).toContain('text/event-stream')

    const stream = await readActionResponse<ActionStream<number>>(midway, `${ACTION}/streamed`)

    await expect(stream.ended()).rejects.toBeInstanceOf(ActionError)
  })

  it('keeps the answer of a guard for a status that is no integer', async () => {
    const response = await post('computedStatus', { status: '1.5' }, true)

    expect(response.status).toBe(500)
  })

  it('stops with plain text for an empty message, as for none', async () => {
    const empty = await post('emptyMessage', {}, true)

    expect([empty.status, await empty.text()]).toEqual([403, 'Forbidden'])
  })

  it('puts no form message where only data or fields are given, and a text data is the message', async () => {
    const data = await post('dataOnly', {}, true)
    const text = await post('text', {}, true)

    expect(decodeServerValue(await data.text())).toEqual({ errors: {}, data: { row: 7 } })
    expect(decodeServerValue(await text.text())).toEqual({ errors: { '': 'Not sent' }, data: 'Not sent' })
  })

  it('is what a thrown refuse() answers', async () => {
    const response = await post('thrown', {}, true)

    expect(response.status).toBe(409)
    expect(decodeServerValue(await response.text())).toMatchObject({ errors: { '': 'Over' }, data: 'over' })
  })
})

describe('ctx.deny in a page, a guard and an endpoint', () => {
  it('answers the status and the message of the one object', async () => {
    const handle = async (path: string) => (await app()).handle(new Request(`${ORIGIN}${path}`))
    const [gate, locked, teapot] = await Promise.all([handle('/gate'), handle('/locked'), handle('/teapot.txt')])

    expect([gate.status, await gate.text()]).toEqual([403, 'Upgrade'])
    expect([locked.status, await locked.text()]).toEqual([401, 'Sign in first'])
    expect([teapot.status, await teapot.text()]).toEqual([418, 'Short and stout'])
  })
})

describe('refuse with no status', () => {
  it('reads an undefined status as the status form', () => {
    const status = undefined as number | undefined

    expect(thrown(() => refuse(status, { message: 'Over' }))).toMatchObject({ status: 403, message: 'Over' })
    expect(thrown(() => refuse(status, { message: 'Over', errors: { name: 'x' } }))).toMatchObject({ status: 422, message: 'Over' })
  })
})
