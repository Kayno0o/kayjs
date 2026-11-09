import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/bare/src/routes'
const DEX = `import { api, s } from 'kay/server'

export default api()
  .get('/dex/:number', ({ params }) => ({ number: params.number, kind: typeof params.number }), { params: s.Object({ number: s.Integer({ minimum: 1 }) }) })
  .get('/tags/:tag', ({ params }) => ({ tag: params.tag }), { params: s.Object({ tag: s.String({ minLength: 2 }) }) })
`

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(process.cwd(), '.kay/api-params-'))
  await Bun.write(join(dir, 'api/temtem.ts'), DEX)
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

describe('an api route with a params schema over real HTTP', () => {
  it.each([
    ['production', '', {}],
    ['dev', '', { dev: true }],
    ['a base and trailing slash', '', { base: '/app', trailingSlash: 'always' as const }],
  ])('reads the params as the schema types them in %s', async (_name, base, options) => {
    const served = await pages({ dirs: { routes: ROUTES, api: join(dir, 'api') }, prebuilt: true, ...options })

    served.listen({ port: 0, hostname: '127.0.0.1' })

    try {
      const origin = `http://127.0.0.1:${served.server!.port}${base}`
      const found = await fetch(`${origin}/api/temtem/dex/7`)

      expect(found.status).toBe(200)
      expect(await found.json()).toEqual({ number: 7, kind: 'number' })
      expect((await fetch(`${origin}/api/temtem/dex/0`)).status).toBe(422)
      expect((await fetch(`${origin}/api/temtem/dex/x`)).status).toBe(422)
      expect((await fetch(`${origin}/api/temtem/dex/%E0%A4%A`)).status).toBeLessThan(500)
      expect(await (await fetch(`${origin}/api/temtem/tags/ab`)).json()).toEqual({ tag: 'ab' })
    }
    finally {
      await served.stop(true)
    }
  })
})
