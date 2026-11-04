import { expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { setupPreview } from '../../../src/server/preview'
import editor from '../src/api/editor'
import preview from '../src/api/preview'
import { configure } from '../src/settings'

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

it('sends the editor hint cookie on an answer no cache keeps', async () => {
  configure({ guard: () => undefined })

  const app = new Elysia().onBeforeHandle(({ set }) => {
    set.headers['cache-control'] = 'public, max-age=60'
  }).use(editor)

  const response = await app.handle(new Request('http://localhost/'))

  expect(response.headers.get('set-cookie')).toContain('kay_editor')
  expect(response.headers.get('cache-control')).toBe('no-store')
})
