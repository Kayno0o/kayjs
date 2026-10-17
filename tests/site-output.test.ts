import type { KayConfig } from '../src/config'
import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'

const ROOT = 'tests/fixtures/site-output'

async function appWith(options: Parameters<typeof pages>[0] = {}) {
  return pages({ routes: `${ROOT}/src/routes`, publicDir: `${ROOT}/public`, prebuilt: false, security: false, ...options })
}

async function fetchFrom(app: Awaited<ReturnType<typeof pages>>, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('publicCache', () => {
  const publicCache: KayConfig['publicCache'] = { '/fonts/**': '365d', '**/*.png': '1d', '/img/*': '1h' }

  it('gives a public file the cache of the first pattern its path matches, and keeps revalidating the others', async () => {
    const app = await appWith({ publicCache, dev: false })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=31536000')
    // Both `**/*.png` and `/img/*` match: the first listed wins.
    expect((await fetchFrom(app, '/img/logo.png')).headers.get('cache-control')).toBe('public, max-age=86400')
    expect((await fetchFrom(app, '/notes.txt')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('keeps the etag, and a 304 carries the same cache', async () => {
    const app = await appWith({ publicCache, dev: false })
    const first = await fetchFrom(app, '/fonts/a.woff2')
    const again = await fetchFrom(app, '/fonts/a.woff2', { 'if-none-match': first.headers.get('etag')! })

    expect(again.status).toBe(304)
    expect(again.headers.get('cache-control')).toBe('public, max-age=31536000')
  })

  it('is ignored in development, so an edit shows at once', async () => {
    const app = await appWith({ publicCache, dev: true })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
  })

  it('refuses a duration that is not one', async () => {
    await expect(appWith({ publicCache: { '/x': 'forever' as '1d' }, dev: false })).rejects.toThrow('publicCache[\'/x\']')
  })

  it('applies under a base, whose mount point the proxy takes off', async () => {
    const app = await appWith({ publicCache, base: '/docs', dev: false })

    expect((await fetchFrom(app, '/fonts/a.woff2')).headers.get('cache-control')).toBe('public, max-age=31536000')
  })
})
