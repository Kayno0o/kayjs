import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'bun:test'
import { sqliteRates, sqliteRooms } from '../src/server'
import { disposeOwned } from '../src/server/reload'
import { sqliteStoreAt } from '../src/server/session'
import { scratchDir } from './scratch'

afterEach(() => {
  delete process.env.KAY_DEV_CODE
})

async function useBoth(rates: ReturnType<typeof sqliteRates>, rooms: ReturnType<typeof sqliteRooms>): Promise<void> {
  await rates.hit('a', 1000)
  rooms.add('r', 'c', '"m"')
}

describe('a sqlite store given in a config', () => {
  it('creates no file until it is first used', async () => {
    const dir = await scratchDir('sqlite-lazy-')
    const rates = join(dir, 'data', 'rates.sqlite')
    const rooms = join(dir, 'data', 'rooms.sqlite')
    const sessions = join(dir, 'data', 'sessions.sqlite')
    const ratesStore = sqliteRates(rates)
    const roomsStore = sqliteRooms(rooms)
    const sessionStore = sqliteStoreAt(sessions)

    expect(existsSync(join(dir, 'data'))).toBe(false)

    expect((await ratesStore.hit('a', 1000)).count).toBe(1)
    expect((await ratesStore.hit('a', 1000)).count).toBe(2)
    expect(existsSync(rates)).toBe(true)
    expect(existsSync(rooms)).toBe(false)
    expect(existsSync(sessions)).toBe(false)

    roomsStore.add('r', 'c', '"m"')
    expect(roomsStore.members('r')).toEqual(['"m"'])
    expect(existsSync(rooms)).toBe(true)
    expect(existsSync(sessions)).toBe(false)

    await sessionStore.set('s', { a: 1 }, 60)
    expect(await sessionStore.get('s')).toEqual({ a: 1 })
    expect(existsSync(sessions)).toBe(true)

    roomsStore.close()
  })

  it('closes unopened without creating a file', async () => {
    const file = join(await scratchDir('sqlite-lazy-'), 'rooms.sqlite')

    sqliteRooms(file).close()
    expect(existsSync(file)).toBe(false)
  })

  it('is closed with the module that named it, whichever module used it first', async () => {
    const dir = await scratchDir('sqlite-lazy-')

    process.env.KAY_DEV_CODE = '1'

    const rates = sqliteRates(join(dir, 'rates.sqlite'))
    const rooms = sqliteRooms(join(dir, 'rooms.sqlite'))

    // Used from another module than the one naming it: the stores only get their owner at construction.
    await useBoth(rates, rooms)
    await disposeOwned(new Set([import.meta.path]))
    expect(async () => rates.hit('a', 1000)).toThrow()
    expect(() => rooms.members('r')).toThrow()
  })
})
