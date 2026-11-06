import { afterAll, afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { Elysia } from 'elysia'
import { schedule } from '../src/server'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/base-site/src/routes'
const api = 'tests/fixtures/base-site/src/api'
const ran: string[] = []
const hourly = async () => void ran.push('hourly')
const quick = async () => void ran.push('quick')

async function failing() {
  throw new Error('boom')
}

const site = await testSite({
  dirs: { routes, api },
  islands: false,
  use: [new Elysia().use(schedule('@hourly', hourly)).use(schedule('30s', quick)).use(schedule('@daily', failing))],
})
const bare = await testSite({ dirs: { routes, api }, islands: false })

afterAll(async () => {
  await Promise.all([site.close(), bare.close()])
})

afterEach(() => {
  ran.length = 0
  setSystemTime()
})

describe('site.runSchedule()', () => {
  it('fires the job of one schedule once, named by its text or its function', async () => {
    expect(await site.runSchedule('@hourly')).toBe(1)
    expect(ran).toEqual(['hourly'])
    expect(await site.runSchedule(quick)).toBe(1)
    expect(await site.runSchedule('30s')).toBe(1)
    expect(ran).toEqual(['hourly', 'quick', 'quick'])
  })

  it('fires every schedule without an argument, a failing run reported rather than thrown', async () => {
    expect(await site.runSchedule()).toBe(3)
    expect(ran.toSorted()).toEqual(['hourly', 'quick'])
  })

  it('fails naming the schedules the site has when none matches', async () => {
    await expect(site.runSchedule('@weekly')).rejects.toThrow('@hourly')
    await expect(bare.runSchedule()).rejects.toThrow('none')
  })
})

describe('site.advance()', () => {
  it('moves the clock and fires a schedule at every instant it fell due, with the clock at that instant', async () => {
    setSystemTime(new Date('2030-01-01T00:10:00Z'))
    const stamps: number[] = []
    const timed = await testSite({ dirs: { routes, api }, islands: false, use: [schedule('15m', async () => void stamps.push(Date.now()))] })

    expect(await timed.advance('1h')).toBe(4)
    expect(stamps.map(at => new Date(at).toISOString())).toEqual([
      '2030-01-01T00:15:00.000Z',
      '2030-01-01T00:30:00.000Z',
      '2030-01-01T00:45:00.000Z',
      '2030-01-01T01:00:00.000Z',
    ])
    expect(new Date().toISOString().slice(0, 16)).toBe('2030-01-01T01:10')
    await timed.close()
  })

  it('fires a cron at its instants only', async () => {
    setSystemTime(new Date('2030-01-01T00:10:00Z'))
    expect(await site.advance('1h')).toBe(121)
    expect(ran.filter(name => name === 'hourly')).toEqual(['hourly'])
    expect(ran.filter(name => name === 'quick')).toHaveLength(120)
  })

  it('refuses a span firing past the cap, the clock landing on the target all the same', async () => {
    setSystemTime(new Date('2030-01-01T00:00:00Z'))
    await expect(site.advance('30d')).rejects.toThrow('smaller steps')
    expect(new Date().toISOString().slice(0, 10)).toBe('2030-01-31')
  })

  it('puts the clock back when the site closes', async () => {
    const timed = await testSite({ dirs: { routes, api }, islands: false })
    const real = Date.now()

    await timed.advance('365d')
    expect(Date.now() - real).toBeGreaterThan(300 * 86_400_000)
    await timed.close()
    expect(Math.abs(Date.now() - real)).toBeLessThan(10_000)
  })
})
