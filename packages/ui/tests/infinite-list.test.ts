import type { InfinitePage, PageAt } from '../src/infinite-list'
import { describe, expect, test } from 'bun:test'
import { infiniteList } from '../src/infinite-list'

interface Ban {
  id: number
}

const NONE = { text: '', fields: {} }

const bans = (from: number, count: number): Ban[] => Array.from({ length: count }, (_, index) => ({ id: from + index }))

// A source answering from a queue, remembering where each call asked.
function source(...answers: (Ban[] | undefined | Error)[]) {
  const asked: PageAt<Ban>[] = []
  const load = async (at: PageAt<Ban>): Promise<InfinitePage<Ban>> => {
    asked.push(at)

    const answer = answers.shift()

    if (answer instanceof Error)
      throw answer

    return answer
  }

  return { asked, load }
}

describe('infiniteList', () => {
  test('a first page shorter than size, or empty, ends the list at once', () => {
    const { load } = source()

    expect(infiniteList(bans(1, 2), { pageSize: 3, load }).ended()).toBe(true)
    expect(infiniteList([], { pageSize: 3, load }).ended()).toBe(true)
    expect(infiniteList(bans(1, 3), { pageSize: 3, load }).ended()).toBe(false)
  })

  test('retry loads nothing when no page failed', async () => {
    const { asked, load } = source(bans(4, 3))
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })

    await list.retry()

    expect(asked).toEqual([])
  })

  test('an ended list never calls load', async () => {
    const { asked, load } = source(bans(1, 3))
    const list = infiniteList(bans(1, 2), { pageSize: 3, load })

    await list.more()

    expect(asked).toEqual([])
  })

  test('asks for the next page by offset and last row, and a short page ends the list', async () => {
    const { asked, load } = source(bans(4, 3), bans(7, 1))
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })

    await list.more()

    expect(asked).toEqual([{ offset: 3, last: { id: 3 }, sort: undefined, filter: NONE }])
    expect(list.rows().map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(list.ended()).toBe(false)

    await list.more()

    expect(asked.at(-1)).toEqual({ offset: 6, last: { id: 6 }, sort: undefined, filter: NONE })
    expect(list.rows()).toHaveLength(7)
    expect(list.ended()).toBe(true)
  })

  test('an exact-size last page is followed by one empty page, which ends the list', async () => {
    const { asked, load } = source(bans(4, 3), [])
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })

    await list.more()
    await list.more()
    await list.more()

    expect(asked).toHaveLength(2)
    expect(list.ended()).toBe(true)
    expect(list.rows()).toHaveLength(6)
  })

  test('a failure waits for a retry, which asks for the same page again and clears it', async () => {
    const { asked, load } = source(new Error('down'), undefined, bans(4, 3))
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })

    await list.more()

    expect(list.failed()).toBe(true)

    await list.more()

    expect(asked).toHaveLength(1)

    await list.retry()

    expect(list.failed()).toBe(true)
    expect(asked).toHaveLength(2)

    await list.retry()

    expect(asked.map(at => at.offset)).toEqual([3, 3, 3])
    expect(list.failed()).toBe(false)
    expect(list.rows()).toHaveLength(6)
  })

  test('a row already shown is dropped by its key, and the offset still counts it', async () => {
    const { asked, load } = source([{ id: 3 }, { id: 4 }, { id: 4 }], bans(7, 1))
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, load })

    await list.more()

    expect(list.rows().map(row => row.id)).toEqual([1, 2, 3, 4])

    await list.more()

    expect(asked.at(-1)?.offset).toBe(6)
    expect(list.rows().map(row => row.id)).toEqual([1, 2, 3, 4, 7])
  })

  test('a page of nothing but duplicates moves the offset on rather than asking again for it', async () => {
    const { asked, load } = source(bans(1, 3), [])
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, load })

    await list.more()
    await list.more()

    expect(asked.map(at => at.offset)).toEqual([3, 6])
  })

  test('a cursor source continues after the last row fetched, so a page of duplicates moves it on', async () => {
    const { asked, load } = source([{ id: 3 }, { id: 2 }, { id: 1 }], bans(4, 3))
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, load })

    await list.more()
    await list.more()

    expect(asked.map(at => at.last?.id)).toEqual([3, 1])
    expect(list.rows().map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('calls load once while a page is on its way, whoever asks', async () => {
    let release: (page: Ban[]) => void = () => undefined
    let calls = 0
    const list = infiniteList(bans(1, 3), { pageSize: 3, load: async () => {
      calls++

      return new Promise<Ban[]>(resolve => release = resolve)
    } })
    const first = list.more()
    const second = list.more()
    const third = list.retry()

    expect(list.pending()).toBe(true)

    release(bans(4, 3))
    await Promise.all([first, second, third])

    expect(calls).toBe(1)
    expect(list.pending()).toBe(false)
    expect(list.rows()).toHaveLength(6)
  })

  test('sortBy starts over from offset 0 with the sort, the old rows staying until its first page lands', async () => {
    const { asked, load } = source(bans(10, 3), bans(13, 1))
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, load })

    await list.more()
    expect(list.rows()).toHaveLength(6)

    const sorting = list.sortBy({ key: 'id', direction: 'desc' })

    expect(list.rows()).toHaveLength(6)
    expect(list.pending()).toBe(true)
    await sorting
    expect(asked.at(-1)).toEqual({ offset: 0, last: undefined, sort: { key: 'id', direction: 'desc' }, filter: NONE })
    expect(list.rows().map(ban => ban.id)).toEqual([13])
    expect(list.ended()).toBe(true)
  })

  test('sortBy revives an ended or failed list, and the first load gets the sort the list began with', async () => {
    const { asked, load } = source(undefined, bans(1, 3))
    const first = { key: 'id', direction: 'asc' as const }
    const list = infiniteList(bans(1, 2), { pageSize: 3, sort: first, load })

    expect(list.ended()).toBe(true)
    await list.sortBy(undefined)
    expect(list.failed()).toBe(true)
    await list.sortBy(first)
    expect(list.failed()).toBe(false)
    expect(list.ended()).toBe(false)
    expect(asked.map(at => at.sort)).toEqual([undefined, first])
  })

  test('a page asked for before sortBy is dropped when it lands', async () => {
    const waiting: ((page: Ban[]) => void)[] = []
    const load = async (): Promise<InfinitePage<Ban>> => new Promise((resolve) => {
      waiting.push(resolve)
    })
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })
    const stale = list.more()
    const fresh = list.sortBy({ key: 'id', direction: 'desc' })

    waiting[0]!(bans(100, 3))
    await stale
    expect(list.rows().map(ban => ban.id)).toEqual([1, 2, 3])

    waiting[1]!(bans(50, 2))
    await fresh
    expect(list.rows().map(ban => ban.id)).toEqual([50, 51])
    expect(list.pending()).toBe(false)
  })

  test('a sortBy whose first page failed keeps the old rows, and retry reloads from offset 0 in the new order', async () => {
    const { asked, load } = source(undefined, bans(1, 2))
    const list = infiniteList(bans(5, 3), { pageSize: 3, key: ban => ban.id, load })
    const by = { key: 'id', direction: 'asc' as const }

    await list.sortBy(by)
    expect(list.failed()).toBe(true)
    expect(list.rows().map(ban => ban.id)).toEqual([5, 6, 7])
    expect(list.sort()).toEqual(by)

    await list.retry()
    expect(asked.map(at => at.offset)).toEqual([0, 0])
    expect(list.rows().map(ban => ban.id)).toEqual([1, 2])
  })

  test('filterBy starts over from offset 0 with the filter, keeping the sort and leaving out what it does not name', async () => {
    const { asked, load } = source(bans(20, 1), bans(30, 1))
    const sort = { key: 'id', direction: 'asc' as const }
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, sort, filter: { fields: { origin: 'a' } }, load })

    await list.filterBy({ text: 'x', fields: { origin: 'b' } })
    expect(asked.at(-1)).toEqual({ offset: 0, last: undefined, sort, filter: { text: 'x', fields: { origin: 'b' } } })
    expect(list.rows().map(ban => ban.id)).toEqual([20])
    expect(list.filter()).toEqual({ text: 'x', fields: { origin: 'b' } })

    await list.filterBy({ text: 'y' })
    expect(asked.at(-1)?.filter).toEqual({ text: 'y', fields: {} })
  })

  test('restart changes the sort and the filter together with a single load', async () => {
    const { asked, load } = source(bans(20, 1), bans(30, 1))
    const sort = { key: 'id', direction: 'desc' as const }
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })

    await Promise.all([list.sortBy(sort), list.filterBy({ text: 'x' }), list.restart({ sort, filter: { text: 'x' } })])

    expect(asked).toEqual([{ offset: 0, last: undefined, sort, filter: { text: 'x', fields: {} } }])
    expect(list.rows().map(ban => ban.id)).toEqual([20])
  })

  test('patch changes one loaded row by its key and leaves the others as they are', async () => {
    const { load } = source(bans(4, 3))
    const first = bans(1, 3).map(ban => ({ ...ban, seen: false }))
    const list = infiniteList(first, { pageSize: 3, key: ban => ban.id, load: async at => (await load(at))?.map(ban => ({ ...ban, seen: false })) })

    await list.more()

    const before = list.rows()

    expect(list.patch(5, { seen: true })).toBe(true)
    expect(list.rows().map(row => row.seen)).toEqual([false, false, false, false, true, false])
    expect(list.rows()[0]).toBe(before[0])
    expect(list.patch(2, row => ({ ...row, id: 2, seen: !row.seen }))).toBe(true)
    expect(list.rows()[1]?.seen).toBe(true)
  })

  test('patch answers false for an unknown row, an undefined change and a list with no key', () => {
    const { load } = source()
    const keyed = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, load })
    const loose = infiniteList(bans(1, 3), { pageSize: 3, load })

    expect(keyed.patch(9, {})).toBe(false)
    expect(keyed.patch(1, undefined)).toBe(false)
    expect(loose.patch(1, {})).toBe(false)
    expect(keyed.rows()).toEqual(bans(1, 3))
  })

  test('a more in the tick a restart waits loads its first page once, in the new order', async () => {
    const { asked, load } = source(bans(20, 3))
    const sort = { key: 'id', direction: 'desc' as const }
    const list = infiniteList(bans(1, 3), { pageSize: 3, load })

    await Promise.all([list.sortBy(sort), list.more()])

    expect(asked).toEqual([{ offset: 0, last: undefined, sort, filter: NONE }])
    expect(list.rows().map(ban => ban.id)).toEqual([20, 21, 22])
  })

  test('patch moving a row to a new key lets a later page show the old key and drops one bringing the new', async () => {
    const { load } = source([{ id: 1 }, { id: 9 }, { id: 4 }])
    const list = infiniteList(bans(1, 3), { pageSize: 3, key: ban => ban.id, load })

    expect(list.patch(1, row => ({ ...row, id: 9 }))).toBe(true)

    await list.more()

    expect(list.rows().map(ban => ban.id)).toEqual([9, 2, 3, 1, 4])
  })

  test('patch keeps the other rows of a later page as they were and the prototype of a merged row', async () => {
    class Planet {
      constructor(readonly id: number, readonly seen = false) {}

      get label() {
        return `planet ${this.id}`
      }
    }

    const { load } = source(bans(4, 3))
    const list = infiniteList([new Planet(1), new Planet(2), new Planet(3)], { pageSize: 3, key: planet => planet.id, load: async at => (await load(at))?.map(ban => new Planet(ban.id)) })

    await list.more()

    const before = list.rows()

    expect(list.patch(5, { seen: true })).toBe(true)
    expect(list.rows()[4]).toBeInstanceOf(Planet)
    expect([list.rows()[4]?.seen, list.rows()[4]?.label]).toEqual([true, 'planet 5'])
    expect(list.rows().filter((_, at) => at !== 4).every((row, at) => row === before.filter((_, index) => index !== 4)[at])).toBe(true)
  })
})
