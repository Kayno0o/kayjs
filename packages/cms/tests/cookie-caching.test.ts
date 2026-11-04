import { expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { setupPreview } from '../../../src/server/preview'
import preview from '../src/api/preview'

it('makes a public answer private when leaving preview clears the cookie', async () => {
  setupPreview({ secret: 'a test secret that is long enough to sign' }, '')

  try {
    const app = new Elysia().onBeforeHandle(({ set }) => {
      set.headers['cache-control'] = 'public, max-age=60'
    }).use(preview)

    const response = await app.handle(new Request('http://localhost/exit', { method: 'POST' }))

    expect(response.headers.get('set-cookie')).not.toBeNull()
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
  }
  finally {
    setupPreview(undefined, '')
  }
})
