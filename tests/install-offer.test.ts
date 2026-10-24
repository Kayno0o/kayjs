import { runInNewContext } from 'node:vm'
import { afterAll, describe, expect, it } from 'bun:test'
import { sourceHash } from '../src/server/csp'
import { INSTALL_OFFER } from '../src/server/offline'
import { push } from '../src/server/push'
import { testSite } from '../src/test'

const OFFER = 'beforeinstallprompt'
const ROOT = 'tests/fixtures/install-offer'

const plain = await testSite({ root: ROOT, browser: true })
const pushing = await testSite({ root: ROOT, browser: true, extensions: [push()], offline: true })

afterAll(async () => {
  await plain.close()
  await pushing.close()
})

describe('the install offer kept from the first moment', () => {
  it('is in the head of a page whose island uses installPrompt, with no push() listed', async () => {
    const response = await plain.fetch('/')
    const html = await response.text()

    expect(html).toContain(OFFER)
    expect(html.indexOf(OFFER)).toBeLessThan(html.indexOf('<body'))
    expect(response.headers.get('content-security-policy')).toContain(sourceHash(INSTALL_OFFER))
  })

  it('holds an offer the browser fires before any island hydrated', async () => {
    const html = await (await plain.fetch('/')).text()
    const script = [...html.matchAll(/<script>([^<]*)<\/script>/g)].map(match => match[1]!).find(text => text.includes(OFFER))!
    const listeners = new Map<string, (event: object) => void>()
    const scope: Record<string, unknown> = { Event: class { constructor(readonly type: string) {} }, addEventListener: (type: string, listener: (event: object) => void) => listeners.set(type, listener), dispatchEvent: () => true }

    scope.window = scope
    runInNewContext(script, scope)

    const offer = { defaultPrevented: false, preventDefault() {
      this.defaultPrevented = true
    } }

    listeners.get(OFFER)!(offer)
    expect(offer.defaultPrevented).toBe(true)
    expect(scope.$kayInstall).toBe(offer)
  })

  it('is on no other page: a counter island, an island using webPush alone', async () => {
    for (const path of ['/plain', '/notify'])
      expect(await (await plain.fetch(path)).text()).not.toContain(OFFER)
  })

  it('is written once when push() already keeps it in the registration script', async () => {
    const html = await (await pushing.fetch('/')).text()

    expect(html.split(OFFER)).toHaveLength(2)
  })
})
