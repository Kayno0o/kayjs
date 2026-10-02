import { describe, expect, it } from 'bun:test'
import { launch } from './browser'
import { clientRows, PATHS, serverMarkup } from './markup'

// A benchmark is only fair when every app renders the same page, on the server and in the browser.
describe('bench apps', () => {
  it.each(PATHS)('server-render the same markup for %s', async (path) => {
    const [kay, ...others] = await serverMarkup(path)

    expect(kay!.length).toBeGreaterThan(200)
    for (const markup of others)
      expect(markup).toBe(kay!)
  }, 30_000)

  it('create the same table rows in the browser', async () => {
    const browser = await launch()

    try {
      const [kay, ...others] = await clientRows(browser)

      expect(kay).toContain('<tr><td class="id">1</td>')
      for (const rows of others)
        expect(rows).toBe(kay!)
    }
    finally {
      await browser.close()
    }
  }, 60_000)
})
