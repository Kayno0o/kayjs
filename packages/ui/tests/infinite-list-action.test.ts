import type { Action, CallOptions } from 'kay'
import type { PageAt } from '../src/infinite-list'
import { describe, expect, test } from 'bun:test'
import { action, s } from 'kay'
import { infiniteList } from '../src/infinite-list'
import { pageFields, pageOf } from '../src/paging'

interface Ban {
  id: number
}

const bans = (from: number, count: number): Ban[] => Array.from({ length: count }, (_, index) => ({ id: from + index }))

// Stands for an action called from an island: it answers from a queue and keeps what each call carried.
function fake(...answers: unknown[]) {
  const calls: { input: unknown, options: CallOptions | undefined }[] = []
  const call = async (input: unknown, options?: CallOptions) => {
    calls.push({ input, options })

    const answer = answers.shift()

    if (answer instanceof Error)
      throw answer

    return answer
  }

  return { calls, action: call as unknown as Action<{ host?: string, before?: number, offset?: number, limit?: number }, Ban[]> }
}

// Only for its types: the real action, as a page declares it.
const listBans = action(s.Object({ ...pageFields(), host: s.Optional(s.String()) }), ({ offset = 0, limit = 100 }) => pageOf(bans(1, 300), { offset, limit }))

describe('pageFields and pageOf', () => {
  test('the fields are the paging pair and the bounds are named once', () => {
    expect(Object.keys(pageFields())).toEqual(['offset', 'limit'])
    expect(pageFields(50).limit.maximum).toBe(50)
    expect(pageFields().limit.maximum).toBe(500)
  })

  test('an action declaring them takes the pair and answers a page', () => {
    expect(listBans.url).toBeString()
  })

  test('a held list is cut to the page asked for, with its total', () => {
    expect(pageOf(bans(1, 10), { offset: 2, limit: 3 })).toEqual({ rows: bans(3, 3), total: 10 })
    expect(pageOf(bans(1, 150)).rows).toHaveLength(100)
  })
})

describe('infiniteList over an action', () => {
  test('calls the action with the fixed fields, the offset and the page size, without refreshing the page', async () => {
    const { calls, action: source } = fake(bans(4, 3))
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, action: source, input: { host: 'a' }, failure: 'Could not load.' })

    await list.more()

    expect(calls).toEqual([{ input: { host: 'a', offset: 3, limit: 3 }, options: { refresh: false } }])
    expect(list.rows()).toHaveLength(6)
  })

  test('a function input is the whole call, and undefined loads an empty page', async () => {
    const { calls, action: source } = fake(bans(4, 1))
    const list = infiniteList(bans(1, 3), { pageSize: 3, action: source, input: (at: PageAt<Ban>) => at.last && { before: at.last.id }, failure: 'Could not load.' })

    await list.more()

    expect(calls.map(call => call.input)).toEqual([{ before: 3 }])

    const empty = infiniteList<Ban, typeof source>([], { pageSize: 3, action: source, input: () => undefined, failure: 'Could not load.' })

    await empty.sortBy({ key: 'id', direction: 'asc' })

    expect(calls).toHaveLength(1)
    expect(empty.rows()).toEqual([])
    expect(empty.ended()).toBe(true)
  })

  test('rows reads them out of the answer, and a call that throws fails the page until a retry', async () => {
    const paged = fake(new Error('down'), { rows: bans(4, 3), total: 9 })
    const list = infiniteList(bans(1, 3), { pageSize: 3, action: paged.action as unknown as typeof listBans, rows: answer => answer.rows, failure: 'Could not load.' })

    await list.more()

    expect(list.failed()).toBe(true)

    await list.retry()

    expect(list.failed()).toBe(false)
    expect(list.rows()).toHaveLength(6)
  })
})
