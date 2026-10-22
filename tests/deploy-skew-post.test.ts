import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

describe('a native post answered by a page', () => {
  it('marks the document of a post that came back to a page rendering an error, as it does the one of a rendered failure', async () => {
    const site = await testSite({ root: 'tests/fixtures/site' })

    try {
      const post = async (back: string) => site.fetch(`/_kay/action/src/routes/index.kay/add?kay_back=${encodeURIComponent(back)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'http://localhost' }, body: 'title=' })

      const error = await post('/nowhere')
      const html = await error.text()

      expect(error.status).toBe(404)
      expect(html).toContain('Nothing here')
      expect(html).toContain('<meta name="kay-posted">')

      const rendered = await post('/')

      expect(rendered.status).toBe(422)
      expect(await rendered.text()).toContain('<meta name="kay-posted">')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
