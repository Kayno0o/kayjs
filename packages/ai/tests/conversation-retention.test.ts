import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test'
import { personalData } from 'kay/server'
import { ai } from '../src'
import { conversationStore, purgeAged } from '../src/conversation-home'
import { sqliteConversations } from '../src/conversation-store'

const DAY = 24 * 60 * 60 * 1000
const add = [{ role: 'user' as const, content: 'my phone is 06 12 34 56 78' }, { role: 'assistant' as const, content: 'noted' }]
const change = { drop: 0, add, title: 'Phone' }

beforeEach(() => ai())

afterEach(() => {
  setSystemTime()
  ai()
})

describe('a conversation store', () => {
  it('lists, erases and ages the conversations of an owner under every scope', async () => {
    const store = sqliteConversations(':memory:')

    await store.write({ owner: 'ann', scope: '/a', id: 'c1' }, 0, change)
    await store.write({ owner: 'ann', scope: '/b', id: 'c2' }, 0, change)
    await store.write({ owner: 'bob', scope: '/a', id: 'c3' }, 0, change)

    const mine = await store.ownedBy!('ann')

    expect(mine.map(({ scope, id }) => `${scope}:${id}`).toSorted()).toEqual(['/a:c1', '/b:c2'])
    expect(mine[0]!.turns.map(turn => turn.content)).toEqual(add.map(turn => turn.content))
    expect(await store.eraseOwner!('ann')).toBe(2)
    expect(await store.ownedBy!('ann')).toEqual([])
    expect(await store.get({ owner: 'bob', scope: '/a', id: 'c3' })).toBeDefined()
    expect(await store.deleteOlderThan!(Date.now() + 1000)).toBe(1)
    expect(await store.deleteOlderThan!(Date.now() + 1000)).toBe(0)
  })
})

describe('what an erase and an export of a person reach', () => {
  it('lists the conversations in the export of the user and erases them with the account, with no setup', async () => {
    const store = conversationStore()

    await store.write({ owner: 'ann', scope: '/a', id: 'c1' }, 0, change)
    await store.write({ owner: 'bob', scope: '/a', id: 'c2' }, 0, change)

    const exported = await personalData.export('ann')

    expect(exported.ai).toMatchObject([{ scope: '/a', id: 'c1', title: 'Phone', turns: [{ content: 'my phone is 06 12 34 56 78' }, { content: 'noted' }] }])
    expect(await personalData.export('nobody')).toEqual({})
    expect(await personalData.erase('ann')).toBe(1)
    expect(await store.get({ owner: 'ann', scope: '/a', id: 'c1' })).toBeUndefined()
    expect(await store.get({ owner: 'bob', scope: '/a', id: 'c2' })).toBeDefined()
  })
})

describe('a store that cannot erase or export', () => {
  it('fails the erase and the export, naming the missing method, instead of keeping the data', async () => {
    const { ownedBy, eraseOwner, ...bare } = sqliteConversations(':memory:')

    void ownedBy
    void eraseOwner
    ai({ conversations: bare })
    await expect(personalData.erase('ann')).rejects.toThrow('eraseOwner')
    await expect(personalData.export('ann')).rejects.toThrow('ownedBy')
  })
})

describe('the user a conversation is erased by', () => {
  it('is its owner, else the signed-in user stored beside it, rows from before that included', async () => {
    const store = conversationStore()

    await store.write({ owner: 'custom', user: 'u1', scope: '/a', id: 'c1' }, 0, change)
    await store.write({ owner: 'u2', scope: '/a', id: 'c2' }, 0, change)
    expect((await personalData.export('u1')).ai).toHaveLength(1)
    expect((await personalData.export('u2')).ai).toHaveLength(1)
    expect(await personalData.erase('u1')).toBe(1)
    expect(await store.get({ owner: 'custom', scope: '/a', id: 'c1' })).toBeUndefined()
  })
})

describe('the age conversations are kept to', () => {
  async function ageOf(days: number, option?: Parameters<typeof ai>[0]): Promise<boolean> {
    ai(option)

    const store = conversationStore()
    const now = Date.now()

    setSystemTime(now)
    await store.write({ owner: 'ann', scope: '/a', id: 'c1' }, 0, change)
    setSystemTime(now + days * DAY)
    await purgeAged(store)

    return await store.get({ owner: 'ann', scope: '/a', id: 'c1' }) !== undefined
  }

  it('purges one untouched for a year unless set', async () => {
    expect(await ageOf(300)).toBe(true)
    expect(await ageOf(400)).toBe(false)
  })

  it('takes the age the app sets, or false to keep them', async () => {
    expect(await ageOf(20, { conversationAge: '30d' })).toBe(true)
    expect(await ageOf(40, { conversationAge: '30d' })).toBe(false)
    expect(await ageOf(4000, { conversationAge: false })).toBe(true)
  })

  it('looks again at most once an hour', async () => {
    ai({ conversationAge: '1d' })

    const store = conversationStore()
    const now = Date.now()

    await purgeAged(store)
    setSystemTime(now - 3 * DAY)
    await store.write({ owner: 'ann', scope: '/a', id: 'old' }, 0, change)
    setSystemTime(now + 60_000)
    await purgeAged(store)
    expect(await store.get({ owner: 'ann', scope: '/a', id: 'old' })).toBeDefined()
    setSystemTime(now + 61 * 60_000)
    await purgeAged(store)
    expect(await store.get({ owner: 'ann', scope: '/a', id: 'old' })).toBeUndefined()
  })

  it('refuses an age that is no duration', () => {
    expect(() => ai({ conversationAge: 'soon' as '1d' })).toThrow('conversationAge')
  })
})
