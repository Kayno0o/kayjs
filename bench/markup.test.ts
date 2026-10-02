import { describe, expect, it } from 'bun:test'
import { APPS } from './apps'
import { renderVisible } from './markup'

// A benchmark is only fair when every app renders the same page.
describe('bench apps', () => {
  it.each(['/', '/table'])('render the same markup for %s', async (path) => {
    const [kay, ...others] = await Promise.all(APPS.map(async app => renderVisible(app, path)))

    expect(kay!.length).toBeGreaterThan(200)
    for (const markup of others)
      expect(markup).toBe(kay!)
  }, 30_000)
})
