import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { applySafeFixes } from '../src/check/fixes'
import { refusalCalls } from '../src/check/refusal-calls'
import { refuse, thrownRefusal } from '../src/runtime/refuse'
import { decodeServerValue, encodeValue } from '../src/runtime/wire'
import { scratchDir } from './scratch'
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
    expect(() => refuse(200)).toThrow(expect.objectContaining({ code: 'argument-invalid' }))
    expect(() => refuse('Nope', { status: 302 })).toThrow(expect.objectContaining({ code: 'argument-invalid' }))
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

  it('stops as a guard does when it carries nothing, so a guard run with the action context refuses the same way', async () => {
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

describe('the fixers and refuse', () => {
  it('reads an undefined status as the status form', () => {
    const status = undefined as number | undefined

    expect(thrown(() => refuse(status, { message: 'Over', errors: { name: 'x' } }))).toMatchObject({ status: 422, message: 'Over' })
  })
})

// What the three fixers make of a source: the file after the safe fixes, and how many diagnostics carried one.
async function fixed(source: string): Promise<{ text: string, fixes: number, found: number }> {
  const root = await scratchDir('refusal-fixers-')

  try {
    await Bun.write(join(root, 'src/mod.ts'), source)

    const found = await refusalCalls(root, {})

    await applySafeFixes(root, found)

    return { text: await Bun.file(join(root, 'src/mod.ts')).text(), fixes: found.filter(one => one.fixes?.some(fix => fix.safe)).length, found: found.length }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('what the refusal fixers write and leave alone', () => {
  it('writes a parenthesised last argument whole', async () => {
    const { text } = await fixed('export const f = (ctx: any) => ctx.fail(409, 1, ({ name: \'x\' }))\n')

    expect(text).toBe('export const f = (ctx: any) => ctx.deny(409, { data: 1, errors: { name: \'x\' } })\n')
  })

  it('writes a text data as the message, so the form shows it', async () => {
    const { text } = await fixed('export const f = (ctx: any) => ctx.fail(409, \'Taken\', { name: \'x\' })\n')

    expect(text).toBe('export const f = (ctx: any) => ctx.deny(409, { message: \'Taken\', errors: { name: \'x\' } })\n')
  })

  it('writes 422 for a refuse whose errors name fields, not for an empty or non-literal one', async () => {
    const named = await fixed('import { refuse } from \'kay\'\n\nrefuse(\'x\', { errors: { name: \'y\' } })\n')
    const spread = await fixed('import { refuse } from \'kay\'\n\nconst more = {}\nrefuse(\'x\', { errors: { ...more } })\n')

    expect(named.text).toContain('refuse(422, { message: \'x\', errors: { name: \'y\' } })')
    expect(spread.fixes).toBe(0)
    expect(spread.found).toBe(1)
  })

  it('leaves ctx.fail(status), which would stop with plain text as ctx.deny, and a deny with data', async () => {
    const bare = await fixed('export const f = (ctx: any) => ctx.fail(409)\n')
    const withData = await fixed('export const f = ({ deny }: any) => deny(409, \'Taken\', { row: 7 })\n')

    expect([bare.found, bare.fixes]).toEqual([1, 0])
    expect([withData.found, withData.fixes]).toEqual([1, 0])
  })

  it('leaves a ctx.fail that is not returned: a case or a label does not read its value', async () => {
    const switched = await fixed('export function f(ctx: any, x: number) {\n  switch (x) {\n    case 1: ctx.fail(409, 1)\n  }\n}\n')
    const labelled = await fixed('export const f = (ctx: any, x: number) => x ? ctx.fail(409, 1) : ctx.fail(410, 2)\n')

    expect(switched.fixes).toBe(0)
    expect(labelled.fixes).toBe(2)
  })

  it('reads refuse(undefined, { message }) as the status form', () => {
    const status = undefined as number | undefined

    expect(thrown(() => refuse(status, { message: 'Over' }))).toMatchObject({ status: 403, message: 'Over' })
  })
})
