import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, it } from 'bun:test'
import { readActionResponse } from '../src/runtime/action'

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  for (const start = Date.now(); !condition(); await Bun.sleep(5)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

it('follows the redirect a call answers as it is, the server having put it under the base', async () => {
  GlobalRegistrator.register({ url: 'http://localhost/app/admin' })

  try {
    const meta = document.createElement('meta')

    meta.name = 'kay-base'
    meta.content = '/app'
    document.head.append(meta)

    const going = expect(readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/app/about' } }), '/_kay/action/test/go')).rejects.toMatchObject({ location: '/app/about' })

    await until(() => window.location.href === 'http://localhost/app/about')
    await going
    expect(window.location.pathname).toBe('/app/about')
  }
  finally {
    await GlobalRegistrator.unregister()
  }
})

it('rejects with ActionRedirectError once the browser is going, so pending() clears, whatever the target', async () => {
  GlobalRegistrator.register({ url: 'http://localhost/app/admin' })

  try {
    const { actionStub, ActionRedirectError } = await import('../src/runtime/action')
    const go = actionStub('/_kay/action/test/go') as unknown as { (): Promise<unknown>, pending: () => boolean, settled: () => Promise<unknown> }
    const original = globalThis.fetch
    let target = '/app/about'

    globalThis.fetch = (async () => new Response(null, { status: 303, headers: { 'x-kay-redirect': target } })) as unknown as typeof fetch

    try {
      for (const where of ['/app/about', 'https://example.com/x']) {
        target = where

        let error: unknown

        try {
          await go()
        }
        catch (failed) {
          error = failed
        }

        expect(error).toBeInstanceOf(ActionRedirectError)
        expect((error as InstanceType<typeof ActionRedirectError>).location).toBe(where)
        expect(go.pending()).toBe(false)
        await go.settled()
      }
    }
    finally {
      globalThis.fetch = original
    }
  }
  finally {
    await GlobalRegistrator.unregister()
  }
})
