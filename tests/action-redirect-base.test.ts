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

    void readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/app/about' } }), '/_kay/action/test/go')
    await until(() => window.location.href === 'http://localhost/app/about')
    expect(window.location.pathname).toBe('/app/about')
  }
  finally {
    await GlobalRegistrator.unregister()
  }
})
