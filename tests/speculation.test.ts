import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { inlineScriptHashes } from '../src/server'
import { speculationRules } from '../src/server/speculation'
import { scratchBuild } from './prerendered'
import { pages } from './shared-pages'

const ROUTES = 'tests/fixtures/speculation/src/routes'
const FULL = speculationRules('moderate')
const SHORT = speculationRules('moderate', '', '/api', false)
const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers })

describe('the speculation rules of a page', () => {
  let app: Awaited<ReturnType<typeof pages>>

  beforeAll(async () => {
    app = await pages({ routes: ROUTES, prebuilt: false, security: { csp: {} } })
  }, 60_000)

  const html = async (path: string, headers?: Record<string, string>) => (await app.handle(request(path, headers))).text()

  it('are the short ones on a page with no data-prefetch', async () => {
    const page = await html('/plain')

    expect(page).toContain(SHORT)
    expect(page).not.toContain(FULL)
  })

  it.each(['/marked', '/rooted', '/streamed'])('are the full ones on %s, which holds or may gain data-prefetch', async (path) => {
    expect(await html(path)).toContain(FULL)
  })

  it('leave a visitor saving data with neither form', async () => {
    expect(await html('/marked', { 'save-data': 'on' })).not.toContain('speculationrules')
    expect(await html('/plain', { 'save-data': 'on' })).not.toContain('speculationrules')
  })

  it('are both hashed by the content security policy', async () => {
    const policy = (await app.handle(request('/plain'))).headers.get('content-security-policy')!

    for (const hash of inlineScriptHashes())
      expect(policy).toContain(hash)

    expect(inlineScriptHashes()).toContain(`'sha256-${new Bun.CryptoHasher('sha256').update(FULL.slice('<script type="speculationrules">'.length, -'</script>'.length)).digest('base64')}'`)
    expect(inlineScriptHashes()).toContain(`'sha256-${new Bun.CryptoHasher('sha256').update(SHORT.slice('<script type="speculationrules">'.length, -'</script>'.length)).digest('base64')}'`)
  })
})

describe('a prerendered page', () => {
  let build: Awaited<ReturnType<typeof scratchBuild>>

  beforeAll(async () => {
    build = await scratchBuild({ routes: ROUTES })
    await build.prerender({ routes: ROUTES })
  }, 60_000)

  afterAll(async () => build.remove())

  it('with a server island carries the full rules, as the island is spliced in per request', async () => {
    const app = await build.serve({ routes: ROUTES })

    expect(await (await app.handle(request('/island'))).text()).toContain(FULL)
  })
})
