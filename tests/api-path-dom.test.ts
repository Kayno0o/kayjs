import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe('client navigation under a moved apiPath', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/app/' })
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  it('swaps pages, leaves the API of the page\'s kay-api meta and kay\'s own files to the browser, /api by default', async () => {
    const { swappable } = await import('../src/runtime/navigation')
    const at = (path: string) => new URL(path, 'http://localhost')

    document.head.innerHTML = '<meta name="kay-base" content="/app">'
    expect(swappable(at('/app/api/x'))).toBe(false)
    expect(swappable(at('/app/v1/x'))).toBe(true)

    document.head.innerHTML = '<meta name="kay-base" content="/app"><meta name="kay-api" content="/v1">'
    expect(swappable(at('/app/v1/openapi.json'))).toBe(false)
    expect(swappable(at('/app/v1'))).toBe(false)
    expect(swappable(at('/app/v10'))).toBe(true)
    expect(swappable(at('/app/api/x'))).toBe(true)
    expect(swappable(at('/app/_kay/x.js'))).toBe(false)
  })
})
