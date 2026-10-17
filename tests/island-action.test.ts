import type { Action } from '../src/runtime'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { actionStub, reviveActions } from '../src/runtime/action'
import { decodeValue, encodeValue, serverWritten, setActionReviver, unflattenValue } from '../src/runtime/wire'
import { browserPath, testSite } from '../src/test'

const routes = 'tests/fixtures/island-action/src/routes'
const site = await testSite({ routes, browser: true })
const mounted = await testSite({ routes, islands: false, base: '/blog', trailingSlash: 'always' })
const localized = await testSite({ routes, islands: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } })
const developed = await testSite({ routes, islands: false, dev: true })
const fixture = join(import.meta.dir, 'fixtures/island-action/src')
const { greet } = await import(join(fixture, 'routes/index.kay')) as { greet: Action<{ name: string }, string> }
const { shout } = await import(join(fixture, 'routes/other.kay')) as { shout: Action<{ name: string }, string> }
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)

afterAll(async () => {
  await Promise.all([site.close(), mounted.close(), localized.close(), developed.close()])
})

// The `data-props` of every island on a page, as the browser reads them.
function propsOf(html: string): string[] {
  return [...html.matchAll(/data-props='([^']*)'/g)].map(match => match[1]!.replaceAll('&quot;', '"'))
}

describe('an action as an island prop', () => {
  it('goes as its URL, the one the action is registered under, declared in the page or imported from another route', async () => {
    const html = await (await site.fetch('/')).text()

    expect(propsOf(html)).toContain(`[{"run":1,"label":3},["Action",2],"${greet.url}","Ann"]`)
    expect(html).toContain(`"${shout.url}"`)
  })

  it('goes the same under a base with trailing slashes, the browser putting the base on the post', async () => {
    const html = await (await mounted.fetch('/blog/')).text()

    expect(html).toContain(`"${greet.url}"`)
    expect(html).not.toContain('/blog/_kay/action')
  })

  it('goes the same in a localized site and in dev', async () => {
    for (const rendered of [localized, developed]) {
      const html = await (await rendered.fetch('/')).text()

      expect(html).toContain(`"${greet.url}"`)
    }
  })

  it('renders the island on the server calling nothing, with the action ready for its handlers', async () => {
    const html = await (await site.fetch('/')).text()

    expect(html).toContain('<p class="url">')
    expect(html).toContain(greet.url)
  })

  it('refuses an action fixing fields with `with()`, which would lose them on the way', async () => {
    const response = await site.fetch('/fixed')

    expect(response.status).toBe(500)
  })

  it('refuses an action that is no export of a route module, which has no URL', async () => {
    expect((await site.fetch('/anonymous')).status).toBe(500)
  })
})

describe('the wire of an action', () => {
  it('encodes an action only where island props ask for it', () => {
    expect(() => encodeValue({ run: greet })).toThrow()
    expect(encodeValue({ run: greet }, true)).toContain(`"Action"`)
  })

  it('names the fix when props carrying an action reach an island that does not type a prop as one', () => {
    setActionReviver(undefined)
    expect(() => decodeValue(encodeValue({ run: greet }, true), serverWritten)).toThrow('import `Action` from \'kay\'')
  })

  it('revives only a URL under the actions\' own path', () => {
    reviveActions()

    const stub = decodeValue(encodeValue({ run: greet }, true), serverWritten) as { run: Action<unknown, unknown> }

    expect(stub.run.url).toBe(greet.url)
    expect(typeof stub.run).toBe('function')
    expect(() => unflattenValue([{ run: 1 }, ['Action', 2], 'https://evil.example/x'], serverWritten)).toThrow(/malformed/)
    expect(() => unflattenValue([{ run: 1 }, ['Action', 2], '/_kay/action/../../x'.replace('..', '..')], serverWritten)).not.toThrow()
    expect(() => unflattenValue([{ run: 1 }, ['Action', 2], 7], serverWritten)).toThrow(/malformed/)
    expect(actionStub('/_kay/action/a/b').url).toBe('/_kay/action/a/b')
  })

  it('refuses an action with no URL, one no route module exports', () => {
    expect(() => encodeValue({ run: actionStub('') }, true)).toThrow('no URL')
  })

  it('does not take any function for an action', () => {
    expect(() => encodeValue({ run: () => 1 }, true)).toThrow()
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island calling an action it was passed', () => {
  it('calls a declared action', async () => {
    const page = await site.open('/', { path })

    await page.click('#go-Ann')
    await page.waitFor('#answer-Ann', { text: 'Hello Ann' })
    expect(page.errors).toEqual([])
  })

  it('shows the schema\'s refusal as an ActionError and calls an imported action', async () => {
    const page = await site.open('/', { path })

    await page.click('#go-x')
    await page.waitFor('#answer-x', { text: 'refused: Too short' })
    await page.click('#go-Bob')
    await page.waitFor('#answer-Bob', { text: 'HEY Bob' })
    expect(page.errors).toEqual([])
  })

  it('streams an action nested in an object prop', async () => {
    const page = await site.open('/', { path })

    await page.click('button.count')
    await page.waitFor('p.last', { text: '3' })
    expect(page.errors).toEqual([])
  })
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a persistent island passed another action by the next page', () => {
  it('revives the new action as it swaps the page in', async () => {
    const page = await site.open('/p1', { path })

    await page.click('#go-Ann')
    await page.waitFor('#answer-Ann', { text: 'Hello Ann' })
    await page.click('a.next')
    await page.waitFor('h1', { text: 'Two' })
    expect(await page.path()).toBe('/p2')
    await page.click('#go-Ann')
    await page.waitFor('#answer-Ann', { text: 'HEY Ann' })
    expect(page.errors).toEqual([])
  })
})
