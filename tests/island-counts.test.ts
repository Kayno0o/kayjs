import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'

const app = new Elysia().use(await pages({ routes: 'tests/fixtures/island-counts/src/routes', prebuilt: false, security: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } }))

async function html(path: string): Promise<string> {
  return (await app.handle(new Request(`http://localhost${path}`))).text()
}

describe('the islands a page lists, a try block that failed leaving out its own', () => {
  it('sends no message of an island that did not render', async () => {
    const page = await html('/messages')

    expect(page).toContain('Fallback')
    expect(page).not.toContain('counter.label')
  })

  it('still preloads the chunk of an island that failed once and rendered once', async () => {
    const page = await html('/shared')

    expect(page.match(/<link rel="modulepreload" href="\/_kay\/flaky-[^"]*">/g)?.length).toBe(1)
    expect(page.match(/<slot data-component=/g)?.length).toBe(1)
    expect(page).toContain('Fallback')
  })

  it('keeps the island around a try that failed, and the fallback inside it', async () => {
    const page = await html('/nested')

    expect(page.match(/<slot data-component="[^"]*guarded.kay"/g)?.length).toBe(1)
    expect(page).toContain('Fallback')
    expect(page).toMatch(/<link rel="modulepreload" href="\/_kay\/guarded-[^"]*">/)
  })
})
