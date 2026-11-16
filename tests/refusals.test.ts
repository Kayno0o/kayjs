import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { refuse, thrownRefusal } from '../src/runtime/refuse'
import { decodeServerValue } from '../src/runtime/wire'
import { pages } from './shared-pages'

const ORIGIN = 'http://localhost'
const ACTION = '/_kay/action/src/routes/index.kay'

let served: Promise<Elysia> | undefined

async function app(): Promise<Elysia> {
  served ??= (async () => new Elysia().use(await pages({ root: 'tests/fixtures/refusals', prebuilt: false, security: false, requireGuards: false })))()

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

  it('keeps the message-first form working, a 422 when errors name fields', () => {
    expect(thrown(() => refuse('Nope', { errors: { name: 'x' } }))).toMatchObject({ status: 422, message: 'Nope', errors: { name: 'x' } })
    expect(thrown(() => refuse('Nope', { status: 409, data: 1 }))).toMatchObject({ status: 409, message: 'Nope', data: 1 })
    expect(thrown(() => refuse('Nope'))).toMatchObject({ status: 403 })
  })

  it('refuses a status outside 400 to 599', () => {
    expect(() => refuse(200)).toThrow(RangeError)
    expect(() => refuse('Nope', { status: 302 })).toThrow(RangeError)
  })
})

describe('ctx.deny in an action', () => {
  it('fails the post with the message, the fields and the data, as ctx.fail does', async () => {
    const response = await post('refused', { status: '409' }, true)

    expect(response.status).toBe(409)
    expect(decodeServerValue(await response.text())).toMatchObject({ errors: { '': 'Taken', 'name': 'Already taken' }, data: { row: 7 } })
  })

  it('answers a form post with the page again, under the status', async () => {
    const response = await post('refused', { status: '422' })

    expect(response.status).toBe(422)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('stops as a guard does when it carries a message alone, so a guard run with the action context refuses the same way', async () => {
    const bare = await post('bare', {}, true)
    const message = await post('messageOnly', {}, true)

    expect([bare.status, await bare.text()]).toEqual([409, 'Conflict'])
    expect([message.status, await message.text()]).toEqual([403, 'Members only'])
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

  it('answers the old text form with plain text, and ctx.fail as before', async () => {
    const legacy = await post('legacy', {}, true)

    expect([legacy.status, await legacy.text()]).toEqual([403, 'Members only'])

    const old = await post('old', {}, true)

    expect(old.status).toBe(409)
    expect(decodeServerValue(await old.text())).toMatchObject({ errors: { name: 'Already taken' }, data: { row: 7 } })
  })
})

describe('ctx.deny in a page, a guard and an endpoint', () => {
  it('answers the status and the message of the one object', async () => {
    const handle = async (path: string) => (await app()).handle(new Request(`${ORIGIN}${path}`))
    const [gate, legacy, locked, teapot] = await Promise.all([handle('/gate'), handle('/legacy'), handle('/locked'), handle('/teapot.txt')])

    expect([gate.status, await gate.text()]).toEqual([403, 'Upgrade'])
    expect([legacy.status, await legacy.text()]).toEqual([402, 'Pay first'])
    expect([locked.status, await locked.text()]).toEqual([401, 'Sign in first'])
    expect([teapot.status, await teapot.text()]).toEqual([418, 'Short and stout'])
  })
})
