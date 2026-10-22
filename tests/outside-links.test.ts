import { resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { leavesSite } from '../src/runtime/outside'
import { pages } from './shared-pages'

const LINK = /<a\b[^>]*>/g
const OUT = ' target="_blank" rel="noopener"'

// Each link tag of the page by its class, class name apart.
async function links(options: Record<string, unknown> = {}, path = '/'): Promise<Record<string, string>> {
  const site = new Elysia().use(await pages({ root: 'tests/fixtures/outside-links', prebuilt: false, security: false, inlineStyles: false, ...options }))
  const html = await (await site.handle(new Request(`http://localhost${path}`))).text()
  const found: Record<string, string> = {}

  for (const [tag] of html.matchAll(LINK)) {
    const name = (/class="([\w ]+)"/).exec(tag)?.[1] ?? (/href="([^"]*)"/).exec(tag)?.[1] ?? tag

    found[name] = tag
  }

  return found
}

describe('a link leaving the site, in templates', () => {
  it('opens in a new tab with the site known, a static or dynamic href, mixed case included', async () => {
    const tags = await links({ site: 'https://x.example' })

    for (const name of ['static', 'upper', 'plain', 'dynamic', 'slashes', 'backslash', 'spread', 'https://other.example/md'])
      expect(tags[name], name).toContain(OUT)
  })

  it('leaves a same-origin absolute link, a path, a hash, mail, tel and script alone', async () => {
    const tags = await links({ site: 'https://x.example' })

    for (const name of ['same', 'root', 'relative', 'hash', 'mail', 'tel', 'script', 'dynamicSame', 'dynamicRoot', 'https://x.example/md'])
      expect(tags[name], name).not.toContain('target')
  })

  it('treats any absolute http(s) href as outside when no site is known', async () => {
    const tags = await links()

    expect(tags.same).toContain(OUT)
    expect(tags.dynamicSame).toContain(OUT)
    expect(tags['https://x.example/md']).toContain(OUT)
    expect(tags.root).not.toContain('target')
    expect(tags.relative).not.toContain('target')
  })

  it('leaves an element with its own target as written, empty included, and keeps its own rel', async () => {
    const tags = await links({ site: 'https://x.example' })

    expect(tags.target).toContain('target="_self"')
    expect(tags.target).not.toContain('_blank')
    expect(tags.empty).not.toContain('_blank')
    expect(tags.dynamicTarget).not.toContain('_blank')
    expect(tags.spreadTarget).not.toContain('_blank')
    expect(tags.spreadTargetAfter).not.toContain('_blank')
    expect(tags.rel).toContain('rel="author"')
    expect(tags.rel).not.toContain('noopener')
    expect(tags.rel).toContain('target="_blank"')
    expect(tags.dynamicRel).toContain('target="_blank"')
    expect(tags.dynamicRel).not.toContain('noopener')
    expect(tags.spreadRel).toContain('target="_blank"')
    expect(tags.spreadRel).not.toContain('noopener')
  })

  it('still opens a link carrying hreflang in a new tab', async () => {
    expect((await links({ site: 'https://x.example' })).hreflang).toContain(OUT)
  })

  it('compares with the origin of the site under a base, and a trailing slash either way', async () => {
    for (const trailingSlash of ['always', 'never'] as const) {
      const tags = await links({ site: 'https://x.example', base: '/repo', trailingSlash }, trailingSlash === 'always' ? '/' : '/')

      expect(tags.static).toContain(OUT)
      expect(tags.same).not.toContain('target')
      expect(tags.root).not.toContain('target')
    }
  })

  it('stays in the same tab with links.outside set to same-tab', async () => {
    const tags = await links({ site: 'https://x.example', links: { outside: 'same-tab' } })

    for (const [name, tag] of Object.entries(tags))
      expect(tag, name).not.toContain('_blank')
  })

  it('opens links in a new tab with links.outside set to new-tab', async () => {
    expect((await links({ site: 'https://x.example', links: { outside: 'new-tab' } })).static).toContain(OUT)
  })

  it('opens the page\'s own links as on a localized page too', async () => {
    const tags = await links({ site: 'https://x.example', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') } }, '/en')

    expect(tags.static).toContain(OUT)
    expect(tags.root).not.toContain('target')
  })
})

describe('leavesSite', () => {
  const SITE = 'https://x.example'

  it('tells another origin from the site, mixed case, a host-relative href and an opaque origin included', () => {
    for (const href of ['https://other.example/a', 'HTTPS://OTHER.EXAMPLE', 'http://x.example/a', 'https://x.example:8443/a', 'https://sub.x.example/', '//evil.example/x', '/\\evil.example', '\\\\evil.example', '/\t/evil.example', ' \n//evil.example', 'ht\ttps://other.example', 'https://x.example@evil.example/'])
      expect(leavesSite(href, SITE), href).toBe(true)

    for (const href of ['https://x.example/a', 'HTTPS://X.EXAMPLE/a', '/a', '/', '', 'a/b', '../a', '#top', '?q=1', 'mailto:a@other.example', 'tel:+33', 'javascript:alert(1)', 'data:text/html,x', 'ftp://other.example', 'http://', 'https://', undefined, null, 3])
      expect(leavesSite(href, SITE), String(href)).toBe(false)
  })

  it('compares with the origin of a site given with a path', () => {
    expect(leavesSite('https://x.example/other', 'https://x.example/blog')).toBe(false)
    expect(leavesSite('https://y.example/blog', 'https://x.example/blog')).toBe(true)
  })

  it('takes any absolute http(s) href as outside with no known site, or an opaque origin', () => {
    for (const site of [undefined, 'null'])
      expect([leavesSite('https://x.example', site), leavesSite('//x.example', site), leavesSite('/a', site), leavesSite('a', site), leavesSite('mailto:a@b.example', site)]).toEqual([true, true, false, false, false])
  })
})
