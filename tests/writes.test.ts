import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { encodeCall } from '../src/runtime/action'
import { forgetLocalMirrors } from '../src/server/writes'
import { testSite } from '../src/test'

const site = await testSite({ root: 'tests/fixtures/local-collection' })
const SAVE = '/_kay/action/src/routes/index.kay/save'

afterAll(async () => {
  await site.close()
})

beforeEach(async () => {
  await site.fetch('/api/notes/reset', { method: 'POST' })
})

async function save(write: string | undefined, body: object, headers: Record<string, string> = {}): Promise<Response> {
  return site.fetch(SAVE, { method: 'POST', headers: { ...encodeCall(body).headers, ...write !== undefined && { 'x-kay-write': write }, ...headers }, body: encodeCall(body).body as string })
}

async function saves(): Promise<number> {
  return ((await (await site.fetch('/api/notes/stats')).json()) as { saves: number }).saves
}

describe('a write carrying an id', () => {
  it('runs the action once however often it is sent, and answers each time as the first did', async () => {
    const first = await save('write-0001', { id: 'a', title: 'one', rev: 0 })
    const again = await save('write-0001', { id: 'a', title: 'one', rev: 0 })

    expect([first.status, again.status]).toEqual([200, 200])
    expect(await again.text()).toBe(await first.text())
    expect(await saves()).toBe(1)
  })

  it('runs it once for sends that overlap', async () => {
    const answers = await Promise.all([1, 2, 3, 4].map(async () => save('write-0002', { id: 'a', title: 'one', rev: 0 })))

    expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200])
    expect(await saves()).toBe(1)
  })

  it('keeps a conflict answer too, so a retry gets the same row to decide on', async () => {
    await site.fetch('/api/notes/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', title: 'theirs', rev: 5 }) })

    const first = await save('write-0003', { id: 'a', title: 'mine', rev: 1 })

    await site.fetch('/api/notes/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', title: 'newer', rev: 9 }) })

    const again = await save('write-0003', { id: 'a', title: 'mine', rev: 1 })

    expect(first.status).toBe(409)
    expect(again.status).toBe(409)
    expect(await again.text()).toBe(await first.text())
  })

  it('runs a different id, and a write with none, every time', async () => {
    await save('write-0004', { id: 'a', title: 'one', rev: 0 })
    await save('write-0005', { id: 'b', title: 'two', rev: 0 })
    await save(undefined, { id: 'c', title: 'three', rev: 0 })
    await save(undefined, { id: 'c', title: 'three', rev: 1 })

    expect(await saves()).toBe(4)
  })

  it('ignores an id of another shape', async () => {
    await save('x', { id: 'a', title: 'one', rev: 0 })
    await save('x', { id: 'b', title: 'one', rev: 0 })

    expect(await saves()).toBe(2)
  })

  it('does not keep what a guard turned away or the schema refused, which the retry meets again', async () => {
    const denied = await save('write-0006', { id: 'a', title: 'one', rev: 0 }, { cookie: 'refuse=1' })
    const allowed = await save('write-0006', { id: 'a', title: 'one', rev: 0 })

    expect(denied.status).toBe(403)
    expect(allowed.status).toBe(200)
    expect(await saves()).toBe(1)

    const refused = await save('write-0007', { id: 'a', title: '', rev: 0 })

    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(await saves()).toBe(1)
  })
})

describe('forgetLocalMirrors', () => {
  it('sets a cookie a page can read, new each time', () => {
    const request = new Request('https://x.example/')
    const first = forgetLocalMirrors(request)

    expect(first).toStartWith('kay_local_clear=')
    expect(first).not.toContain('HttpOnly')
    expect(first).toContain('Secure')
    expect(forgetLocalMirrors(request)).not.toBe(first)
  })
})
