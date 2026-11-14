import { describe, expect, it } from 'bun:test'
import { overLimitOf } from '../src/server/over-limit'
import { memoryRates } from '../src/server/protection'
import { JSON_POST } from './live-helpers'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

describe('live.rateLimit', () => {
  it('counts in the limit\'s own store and tells onLimit of the opening it refused', async () => {
    const rates = memoryRates()
    const counted = new Set<string>()
    const told: string[] = []
    const store = { hit: (key: string, window: number, weight?: number) => {
      counted.add(key)

      return rates.hit(key, window, weight)
    } }

    const app = await pages({
      root: await fixtureCopy('live-cache'),
      prebuilt: false,
      live: { rateLimit: { max: 1, window: '1m', store, onLimit: ({ name }: { name: string }) => { told.push(name) } } },
    })

    const open = async () => app.handle(new Request('http://localhost/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: [], watch: [] }) }))

    expect((await open()).status).not.toBe(429)
    expect((await open()).status).toBe(429)
    expect(counted.size).toBe(1)
    expect(told).toEqual(['kay:live'])
  })
})

describe('overLimitOf', () => {
  it('counts apart in two stores with the same name, max and window', async () => {
    const rate = (store: ReturnType<typeof memoryRates>) => ({ max: 1, windowMs: 60_000, store: { hit: (key: string, window: number, weight?: number) => store.hit(key, window, weight) } })
    const first = rate(memoryRates())
    const second = rate(memoryRates())

    expect(await overLimitOf('apart', 'c', first)).toBeUndefined()
    expect(await overLimitOf('apart', 'c', second)).toBeUndefined()
    expect(await overLimitOf('apart', 'c', first)).toBeGreaterThan(0)
  })
})
