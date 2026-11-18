import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { liveId } from '../src/build/live-ids'
import { liveSlot, slotValue } from '../src/runtime/live-value'
import { testSite } from '../src/test'

const MINE = liveId('/app/src/live.ts', '/app', 'mine')

type Values = typeof import('./fixtures/live-values/src/live')

let site: Awaited<ReturnType<typeof testSite>>
let live: Values

beforeAll(async () => {
  site = await testSite({ root: 'tests/fixtures/live-values' })
  live = await import(resolve('tests/fixtures/live-values/src/live.ts')) as Values
})

afterAll(async () => site.close())

describe('set of a live value per key', () => {
  it('writes the next value under the key of its options', () => {
    live.room.set({ id: 'blue', users: 4 }, { key: 'blue' })
    expect(live.room('blue')).toEqual({ id: 'blue', users: 4 })
    live.room.delete('blue')
    expect(live.room('blue')).toEqual({ id: 'blue', users: 0 })
  })

  it('refuses the key first, the form before 1.105', () => {
    expect(() => (live.room.set as unknown as (key: string, next: object) => void)('red', { id: 'red', users: 2 })).toThrow('one value for each key')
  })

  it('takes a next value that is an updater or an object', () => {
    live.tally.set(7, { key: 'a' })
    expect(live.tally('a')).toBe(7)
    live.tally.set(n => n + 1, { key: 'a' })
    expect(live.tally('a')).toBe(8)
    live.tally.delete('a')
  })

  it('starts every key of a value declared with `key: true` from a copy of the starting value', () => {
    expect(live.tally('anything')).toBe(5)
    expect(live.tags('x')).toEqual([])
    expect(live.tags('x')).not.toBe(live.tags('y'))
  })

  it('refuses a write that names no key', () => {
    expect(() => (live.tally.set as unknown as (next: number) => void)(3)).toThrow('one value for each key')
  })
})

describe('set of a live value of each user', () => {
  const held = (user: string) => slotValue(liveSlot(MINE)!, user)

  it('writes one user\'s value with the user in the options', () => {
    live.mine.set(3, { user: 'dana' })
    live.mine.set(n => n + 1, { user: 'dana' })
    expect(held('dana')).toBe(4)
    live.mine.delete('dana')
    expect(held('dana')).toBe(0)
  })

  it('refuses the user first, the form before 1.105', () => {
    expect(() => (live.mine.set as unknown as (user: string, next: number) => void)('erin', 9)).toThrow('one value for each user')
  })

  it('refuses a write that names no user', () => {
    expect(() => (live.mine.set as unknown as (next: number) => void)(3)).toThrow('one value for each user')
  })
})

describe('the declaration of a live value', () => {
  it('refuses `user` and `key` together', async () => {
    const { live } = await import('../src/runtime/live-value')

    expect(() => (live as (...args: unknown[]) => unknown)(0, 'id', { user: true, key: true })).toThrow('takes no `key`')
  })

  it('has a render tell no data and no error, as it opens no connection', async () => {
    const { live } = await import('../src/runtime/live-value')
    const value = (live as (...args: unknown[]) => { onData: (listener: () => void) => () => void, onError: (listener: () => void) => () => void })(0, 'tells-nothing')

    expect(value.onData(() => undefined)()).toBeUndefined()
    expect(value.onError(() => undefined)()).toBeUndefined()
  })
})
