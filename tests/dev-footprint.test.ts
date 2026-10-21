import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { carbonPerView, ecoindexScore } from '../src/build/footprint-models'
import { DEV_FOOTPRINT } from '../src/server/dev'
import { devFootprint } from '../src/server/dev-footprint'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const ask = (query: string, headers: Record<string, string> = { 'x-kay-dev': '1' }) => devFootprint(new Request(`http://localhost${DEV_FOOTPRINT}?${query}`, { headers }))

describe('the dev tool\'s footprint figures', () => {
  it('works the grade and the carbon out of the counts with the models kay build uses', async () => {
    const answer = await (await ask('dom=812&requests=14&bytes=431200')).json() as { score: number, grade: string, co2: number, ecoindex: string, swd: number }

    expect(answer).toEqual({ score: ecoindexScore({ dom: 812, requests: 14, bytes: 431_200 }), grade: expect.stringMatching(/^[A-G]$/) as never, co2: carbonPerView(431_200), ecoindex: '5.10.0', swd: 4 })
  })

  it('refuses a request the dev tool did not make, and a count that is not a plain number', async () => {
    expect(ask('dom=1&requests=1&bytes=1', {}).status).toBe(403)
    expect(ask('dom=1&requests=1&bytes=1', { 'x-kay-dev': '1', 'sec-fetch-site': 'cross-site' }).status).toBe(403)

    for (const query of ['', 'dom=1&requests=1', 'dom=-1&requests=1&bytes=1', 'dom=1&requests=NaN&bytes=1', 'dom=1&requests=1&bytes=1e9', 'dom=1&requests=1&bytes=Infinity', 'dom=&requests=1&bytes=1', `dom=1&requests=1&bytes=${'9'.repeat(40)}`])
      expect(ask(query).status).toBe(400)
  })

  it('is served in development only', async () => {
    const root = await scratchDir('dev-footprint-')

    await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n')

    const request = () => new Request(`http://localhost${DEV_FOOTPRINT}?dom=10&requests=2&bytes=5000`, { headers: { 'x-kay-dev': '1' } })

    expect((await (await pages({ root, prebuilt: false, security: false, dev: true })).handle(request())).status).toBe(200)
    expect((await (await pages({ root, prebuilt: false, security: false, dev: false })).handle(request())).status).toBe(404)
  })
})
