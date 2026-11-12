import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, it } from 'bun:test'
import { readActionResponse } from '../src/runtime/action'
import { navigation } from '../src/runtime/navigation'

// The base is read once per page, so this file keeps to one site mounted under `/app`.
it('does not put the base on a redirect again when the swap has taken the app over', async () => {
  GlobalRegistrator.register({ url: 'http://localhost/app/admin' })

  const original = globalThis.fetch

  try {
    const meta = document.createElement('meta')

    meta.name = 'kay-base'
    meta.content = '/app'
    document.head.append(meta)
    navigation.hooks = { hydrate() {}, dispose() {} } as unknown as typeof navigation.hooks

    const seen: string[] = []

    globalThis.fetch = (async (url: unknown) => {
      seen.push(new URL(String(url)).pathname + new URL(String(url)).search)

      return new Response('<html><body>x</body></html>', { status: 404, headers: { 'content-type': 'text/html' } })
    }) as unknown as typeof fetch

    for (const [target, fetched] of [['/app/about', '/app/about'], ['/app/about/', '/app/about/'], ['/app/fr/about?x=1#top', '/app/fr/about?x=1'], ['/app', '/app'], ['/app/app/x', '/app/app/x']] as const) {
      seen.length = 0
      await expect(readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': target } }), '/_kay/action/test/go')).rejects.toMatchObject({ location: target })
      await Bun.sleep(100)
      expect(seen).toEqual([fetched])
    }
  }
  finally {
    globalThis.fetch = original
    navigation.hooks = undefined
    await GlobalRegistrator.unregister()
  }
})
