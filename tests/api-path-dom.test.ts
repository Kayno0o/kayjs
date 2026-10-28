import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe('client navigation under a moved apiPath', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/app/' })
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  // The path is read once a page, so each case loads the module afresh.
  it('swaps pages, leaves the API of the page\'s kay-api meta and kay\'s own files to the browser, /api by default', async () => {
    const fresh = async (key: string) => (await import(`../src/runtime/navigation.ts?${key}`) as typeof import('../src/runtime/navigation')).swappable
    const at = (path: string) => new URL(path, 'http://localhost')

    document.head.innerHTML = '<meta name="kay-base" content="/app">'
    let swappable = await fresh('default')

    expect(swappable(at('/app/api/x'))).toBe(false)
    expect(swappable(at('/app/v1/x'))).toBe(true)

    document.head.innerHTML = '<meta name="kay-base" content="/app"><meta name="kay-api" content="/v1">'
    swappable = await fresh('moved')
    expect(swappable(at('/app/v1/openapi.json'))).toBe(false)
    expect(swappable(at('/app/v1'))).toBe(false)
    expect(swappable(at('/app/v10'))).toBe(true)
    expect(swappable(at('/app/api/x'))).toBe(true)
    expect(swappable(at('/app/_kay/x.js'))).toBe(false)

    // A page swapped in carries the same meta, which is not read again.
    document.head.innerHTML = ''
    expect(swappable(at('/app/v1/x'))).toBe(false)
  })
})
