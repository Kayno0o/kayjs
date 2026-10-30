import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { attribute } from '../src/runtime/html'
import { trustSchemes } from '../src/runtime/url'
import { onUnsafeUrl } from '../src/runtime/url-report'
import { linkSchemes } from '../src/server/link-schemes'
import { answeringRequest } from '../src/server/log'
import { reportUnsafeUrls } from '../src/server/unsafe-urls'
import { pages } from './shared-pages'

const LINK = /<a\b[^>]*>/g

async function render(options: Record<string, unknown> = {}): Promise<{ html: string, tags: Record<string, string> }> {
  const site = new Elysia().use(await pages({ root: 'tests/fixtures/link-schemes', prebuilt: false, security: false, inlineStyles: false, ...options }))
  const html = await (await site.handle(new Request('http://localhost/'))).text()
  const tags: Record<string, string> = {}

  for (const [tag] of html.matchAll(LINK))
    tags[(/class="(\w+)"/).exec(tag)?.[1] ?? tag] = tag

  return { html, tags }
}

afterEach(() => {
  trustSchemes(undefined)
  onUnsafeUrl(undefined)
})

describe('links: { schemes }', () => {
  it('rewrites a bound URL of a scheme nobody trusts to unsafe:', () => {
    expect(attribute('href', 'webcal://example.com/events.ics')).toBe(' href="unsafe:webcal://example.com/events.ics"')
  })

  it('lets a trusted scheme through on a bound URL, whatever its case or leading whitespace, and only on that scheme', () => {
    trustSchemes(['webcal', 'geo'])
    expect(attribute('href', 'webcal://example.com/events.ics')).toBe(' href="webcal://example.com/events.ics"')
    expect(attribute('href', 'GEO:48.85,2.35')).toBe(' href="GEO:48.85,2.35"')
    expect(attribute('formaction', ' \twebcal://x')).toBe(' formaction=" \twebcal://x"')
    expect(attribute('href', 'spotify:track:1')).toBe(' href="unsafe:spotify:track:1"')
    expect(attribute('href', 'web\tcal://x')).toBe(' href="web\tcal://x"')
  })

  it('never lets javascript:, vbscript: or data: through, even when handed to the runtime directly', () => {
    trustSchemes(['javascript', 'vbscript', 'data', 'webcal'])
    expect(attribute('href', 'javascript:alert(1)')).toBe(' href="unsafe:javascript:alert(1)"')
    expect(attribute('href', ' \tJava\nScript:alert(1)')).toBe(' href="unsafe: \tJava\nScript:alert(1)"')
    expect(attribute('formaction', 'VBScript:x')).toBe(' formaction="unsafe:VBScript:x"')
    expect(attribute('src', 'data: text/html,<p>')).toBe(' src="unsafe:data: text/html,&lt;p>"')
  })

  it('tells the reporter each rewritten URL with its attribute and scheme, and none that was kept', () => {
    const seen: string[][] = []

    onUnsafeUrl((name, url, scheme) => seen.push([name, url, scheme]))
    trustSchemes(['geo'])
    attribute('href', 'geo:1,2')
    attribute('href', 'webcal://x')
    attribute('title', 'webcal://x')
    expect(seen).toEqual([['href', 'webcal://x', 'webcal']])
  })

  it('reads the page\'s meta in a browser, where the server never set the list', () => {
    const page = globalThis as { document?: unknown }
    const before = page.document

    page.document = { querySelector: (selector: string) => selector.includes('kay-link-schemes') ? { getAttribute: () => 'webcal,geo' } : null }

    try {
      expect(attribute('href', 'geo:1,2')).toBe(' href="geo:1,2"')
      expect(attribute('href', 'spotify:x')).toBe(' href="unsafe:spotify:x"')
    }
    finally {
      page.document = before
    }
  })

  it('ignores javascript, vbscript and data in a forged meta in the browser, as the server does', () => {
    const page = globalThis as { document?: unknown }
    const before = page.document

    page.document = { querySelector: () => ({ getAttribute: () => 'javascript,vbscript,data,geo' }) }

    try {
      expect(attribute('href', 'javascript:alert(1)')).toBe(' href="unsafe:javascript:alert(1)"')
      expect(attribute('href', 'VBScript:x')).toBe(' href="unsafe:VBScript:x"')
      expect(attribute('src', 'data:text/html,<p>')).toBe(' src="unsafe:data:text/html,&lt;p>"')
      expect(attribute('href', 'geo:1,2')).toBe(' href="geo:1,2"')
    }
    finally {
      page.document = before
    }
  })

  it('takes names as a browser spells them and refuses what is no scheme or may run script', () => {
    expect(linkSchemes({ links: { schemes: ['WebCal', ' geo:', 'x-app+v1.2'] } })).toEqual(['webcal', 'geo', 'x-app+v1.2'])
    expect(linkSchemes({})).toEqual([])

    for (const bad of ['javascript', 'JavaScript:', 'vbscript', 'data', '', 'a b', '//x', '1app', 'web://cal'])
      expect(() => linkSchemes({ links: { schemes: [bad] } }), bad).toThrow('links.schemes')

    expect(() => linkSchemes({ links: { schemes: [3 as unknown as string] } })).toThrow('no URL scheme')
  })

  it('renders a trusted scheme of a bound href on a page, with a meta for the islands, and the rest as before', async () => {
    const { html, tags } = await render({ links: { schemes: ['webcal', 'geo'] } })

    expect(tags.calendar).toContain('href="webcal://example.com/events.ics"')
    expect(tags.place).toContain('href="GEO:48.85,2.35"')
    expect(tags.spaced).toContain('href=" \twebcal://example.com/spaced"')
    expect(tags.script).toContain('href="unsafe:javascript:alert(1)"')
    expect(tags.markup).toContain('href="unsafe:data:text/html,')
    expect(tags.other).toContain('href="unsafe:spotify:track:1"')
    expect(tags.mail).toContain('href="mailto:me@example.com"')
    expect(html).toContain('<meta name="kay-link-schemes" content="webcal,geo">')
  })

  it('keeps rewriting every scheme but the web\'s when the app lists none, with no meta', async () => {
    const { html, tags } = await render()

    expect(tags.calendar).toContain('href="unsafe:webcal://example.com/events.ics"')
    expect(tags.mail).toContain('href="mailto:me@example.com"')
    expect(html).not.toContain('kay-link-schemes')
  })

  it('logs again after a dev config reload', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const lines = () => warn.mock.calls.map(call => call.join(' ')).filter(line => line.includes('rewritten to unsafe:'))

    try {
      reportUnsafeUrls()
      attribute('href', 'webcal://x')
      attribute('href', 'webcal://x')
      expect(lines()).toHaveLength(1)
      reportUnsafeUrls()
      attribute('href', 'webcal://x')
      expect(lines()).toHaveLength(2)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('logs once per attribute, URL and page in dev, naming the scheme and the option', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const site = new Elysia().use(await pages({ root: 'tests/fixtures/link-schemes', prebuilt: false, security: false, inlineStyles: false, dev: true }))

      await site.handle(new Request('http://localhost/'))
      await site.handle(new Request('http://localhost/'))
      const lines = warn.mock.calls.map(call => call.join(' ')).filter(line => line.includes('rewritten to unsafe:'))

      expect(lines.filter(line => line.includes('webcal://example.com/events.ics'))).toHaveLength(1)
      expect(lines.find(line => line.includes('webcal://example.com/events.ics'))).toContain('the bound href "webcal://example.com/events.ics"')
      expect(lines.find(line => line.includes('javascript:alert(1)'))).toContain('none may')
      expect(lines.every(line => line.includes('/'))).toBe(true)
    }
    finally {
      warn.mockRestore()
    }
  })

  it('cuts a long page path in the report, as it cuts a long URL', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined)
    const path = `/${'p'.repeat(150)}`

    try {
      reportUnsafeUrls()
      await answeringRequest(new Request(`http://localhost${path}`), async () => attribute('href', 'webcal://x'))
      const line = warn.mock.calls.map(call => call.join(' ')).find(text => text.includes('rewritten to unsafe:'))!

      expect(line).toContain(`${path.slice(0, 100)}...: the bound href`)
    }
    finally {
      warn.mockRestore()
    }
  })
})
