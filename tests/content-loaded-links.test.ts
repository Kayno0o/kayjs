import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { contentChecks } from '../src/check/project'
import { shutdown } from '../src/server'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const BODY = '[own](/about) [relative](./sibling) [file](page.html?x=1) [hash](#top) [away](https://other.example/a) [bad](javascript:alert(1)) [odd](java%0ascript:alert(2)) [slashes](//evil.example/x)\n\n![pic](./pic.png) ![hostile](data:text/html;base64,AAAA)\n\n# Title\n'
const OUT = ' rel="nofollow ugc" target="_blank"'

const CONFIG = `
import { collection } from 'kay/content'
export const loaded = collection({ name: 'loaded', load: () => [{ slug: 'one', data: { title: 'One' }, body: ${JSON.stringify(BODY)} }] }, { schema: t.Object({ title: t.String() }) })
`
const ROUTE = '--- server\nimport { loaded } from \'../../content.config\'\n\nconst post = await loaded.get(ctx.params.slug) ?? ctx.notFound()\nconst { Content } = post\n---\narticle\n  Content\n'

function tag(html: string, href: string): string {
  return new RegExp(`<a [^>]*href="${href.replaceAll('?', '\\?')}"[^>]*>`).exec(html)?.[0] ?? ''
}

async function copyWithLoader(): Promise<string> {
  const copy = await fixtureCopy('content')
  const config = join(copy, 'src/content.config.ts')

  await Bun.write(config, `${await Bun.file(config).text()}${CONFIG}`)
  await Bun.write(join(copy, 'src/routes/loaded/[slug].kay'), ROUTE)
  await Bun.write(join(copy, 'src/content/posts/same.md'), `---\ntitle: Same\ndate: 2026-09-16\n---\n\n${BODY}`)

  return copy
}

function expectSanitized(html: string): void {
  expect(html).not.toMatch(/javascript:|java%0a|evil\.example|data:text/)
  expect(tag(html, 'https://other.example/a')).toBe(`<a href="https://other.example/a"${OUT}>`)
}

describe('a loaded body\'s links', () => {
  let copy: string
  let app: Elysia
  let localized: Elysia

  beforeAll(async () => {
    copy = await copyWithLoader()
    app = new Elysia().use(await pages({ routes: `${copy}/src/routes`, content: `${copy}/src/content.config.ts`, prebuilt: false, security: false, site: 'https://x.example', base: '/root', trailingSlash: 'always' }))
    localized = new Elysia().use(await pages({ routes: `${copy}/src/routes`, content: `${copy}/src/content.config.ts`, prebuilt: false, security: false, site: 'https://x.example', i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') } }))
  }, 60_000)

  afterAll(async () => {
    await shutdown(app)
    await shutdown(localized)
    await rm(copy, { recursive: true, force: true })
  })

  it('keep the site\'s own links and the heading anchor without a rel, under a base and a trailing slash', async () => {
    const html = await (await app.handle(new Request('http://localhost/loaded/one/'))).text()

    expectSanitized(html)
    expect(tag(html, '/root/about')).toBe('<a href="/root/about">')
    expect(tag(html, '#top')).toBe('<a href="#top">')
    expect(html).toContain('<h1 id="title"><a href="#title">Title</a></h1>')
  })

  it('keep a relative link and image, with no scheme to run', async () => {
    const html = await (await app.handle(new Request('http://localhost/loaded/one/'))).text()

    expect(tag(html, './sibling')).toBe('<a href="./sibling">')
    expect(tag(html, 'page.html?x=1')).toBe('<a href="page.html?x=1">')
    expect(html).toContain('src="./pic.png"')
    expect(html).toContain('<a>bad</a>')
    expect(html).toContain('<a>odd</a>')
  })

  it('write a link of the site as a folder entry\'s is in the page\'s locale', async () => {
    const html = await (await localized.handle(new Request('http://localhost/en/loaded/one'))).text()

    expectSanitized(html)
    const same = await (await localized.handle(new Request('http://localhost/en/blog/same'))).text()

    // Written as a folder entry's link is in the page's locale.
    expect(tag(html, tag(same, '[^"]*about').replace(/^.*href="([^"]*)".*$/, '$1'))).toBe(tag(same, '[^"]*about'))
  })
})

describe('trusted on a folder collection', () => {
  it('is reported by kay check at the config, a loader\'s collection left alone, and follows the lint level', async () => {
    const copy = await fixtureCopy('content')

    try {
      const config = join(copy, 'src/content.config.ts')

      await Bun.write(config, `${await Bun.file(config).text()}${CONFIG.replace('{ schema: t.Object({ title: t.String() }) }', '{ schema: t.Object({ title: t.String() }), trusted: true }')}
export const folder = collection('content/authors', { schema: t.Object({ name: t.String() }), trusted: true })
`)

      const reported = async (lints?: Record<string, 'allow' | 'warn' | 'deny'>) => (await contentChecks(copy, { lints })).problems.filter(problem => problem.code === 'trusted-folder')

      expect((await reported()).map(({ message, severity }) => ({ message: message.slice(0, message.indexOf(',')), severity }))).toEqual([{ message: 'the collection content/authors sets `trusted`', severity: 'warning' }])
      expect((await reported({ 'trusted-folder': 'deny' })).map(({ severity }) => severity)).toEqual(['error'])
      expect(await reported({ 'trusted-folder': 'allow' })).toEqual([])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})
