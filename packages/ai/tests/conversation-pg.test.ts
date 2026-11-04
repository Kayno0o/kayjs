import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { pgConversations } from '../src/conversation-pg'

// Skipped without a Postgres. A database of its own, as TEST_DATABASE_URL names a server whose user may create them, not one to write into.
const server = process.env.TEST_DATABASE_URL ?? ''
const database = `kay_ai_conversations_${process.pid}`
const admin = server === '' ? undefined : new Bun.SQL(Object.assign(new URL(server), { pathname: '/postgres' }).href)
const url = server === '' ? '' : Object.assign(new URL(server), { pathname: `/${database}` }).href

if (admin !== undefined) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${database}`)
}

const store = url === '' ? undefined : pgConversations(url)
const key = { owner: 'ann', scope: '/_kay/action/chat', id: 'c1' }

afterAll(async () => {
  await store?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin?.close()
})

describe.skipIf(url === '')('pgConversations', () => {
  it('writes at the revision read, lists the latest first, renames and deletes with the answer', async () => {
    const first = await store!.write(key, 0, { drop: 0, add: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], title: 'Greeting' })

    expect(first).toBe(1)
    expect(await store!.write(key, 0, { drop: 0, add: [], title: '' })).toBeUndefined()
    expect(await store!.write(key, 1, { drop: 1, add: [{ role: 'assistant', content: 'hey' }], title: '' })).toBe(2)

    const got = await store!.get(key)

    expect(got?.revision).toBe(2)
    expect(got?.title).toBe('Greeting')
    expect(got?.turns.map(turn => turn.content)).toEqual(['hi', 'hey'])
    expect((await store!.list('ann', key.scope, 10)).map(row => row.id)).toEqual(['c1'])
    expect(await store!.rename(key, 'Renamed')).toBe(true)
    expect(await store!.rename({ ...key, id: 'absent' }, 'x')).toBe(false)
    expect(await store!.delete(key)).toBe(true)
    expect(await store!.delete(key)).toBe(false)
    expect(await store!.get(key)).toBeUndefined()
  })

  it('lets one of two writers creating the same conversation at once win', async () => {
    const other = { ...key, id: 'race' }
    const results = await Promise.all([1, 2, 3, 4, 5].map(async n => store!.write(other, 0, { drop: 0, add: [{ role: 'user', content: String(n) }], title: 't' })))

    expect(results.filter(result => result === 1)).toHaveLength(1)
    expect(results.filter(result => result === undefined)).toHaveLength(4)
  })
})
