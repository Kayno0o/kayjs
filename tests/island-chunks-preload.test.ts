import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

describe('the code waiting for an island to be visible or idle', () => {
  const PRELOAD = /<link rel="modulepreload" href="([^"]*hydrate-when-\w+\.js)">/

  it('is preloaded by a page holding such an island, and by no other, as the entry only asks for it once it ran', async () => {
    const site = await testSite({ root: 'tests/fixtures/title', browser: true })

    try {
      const idle = await (await site.fetch('/idle')).text()
      const eager = await (await site.fetch('/')).text()
      const url = PRELOAD.exec(idle)?.[1]

      expect(url).toBeString()
      expect(eager).not.toMatch(PRELOAD)
      expect((await site.fetch(url!)).status).toBe(200)
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
