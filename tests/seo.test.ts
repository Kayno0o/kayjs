import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { siteOrigin as currentSiteOrigin, jsonLd, siteUrl } from '../src/runtime/seo'
import { pages } from '../src/server'
import { siteOrigin } from '../src/server/seo'

const ROUTES = 'tests/fixtures/seo/src/routes'
const HEAD = /<head>([\s\S]*)<\/head>/

const app = await pages({
  routes: ROUTES,
  prebuilt: false,
  publicDir: 'tests/fixtures/seo/share',
  site: 'https://example.com/',
  seo: {
    name: 'Kay site',
    titleTemplate: '%s | Kay site',
    description: 'A site built with kay',
    image: '/og.png',
    imageAlt: 'The kay site',
    twitter: '@kay',
    locale: 'en_GB',
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'WebSite', 'name': 'Kay </script> site' }],
  },
})

async function headOf(path: string): Promise<{ status: number, head: string }> {
  const response = await app.handle(new Request(`http://localhost${path}`))

  return { status: response.status, head: HEAD.exec(await response.text())![1]! }
}

function count(text: string, part: string): number {
  return text.split(part).length - 1
}

describe('seo head', () => {
  it('gives a page that sets nothing the site defaults, its canonical URL and social cards', async () => {
    const { head } = await headOf('/')

    expect(head).toContain('<title>Kay site</title>')
    expect(head).toContain('<link rel="canonical" href="https://example.com/">')
    expect(head).toContain('<meta name="description" content="A site built with kay">')
    expect(head).toContain('<meta property="og:site_name" content="Kay site">')
    expect(head).toContain('<meta property="og:type" content="website">')
    expect(head).toContain('<meta property="og:title" content="Kay site">')
    expect(head).toContain('<meta property="og:description" content="A site built with kay">')
    expect(head).toContain('<meta property="og:url" content="https://example.com/">')
    expect(head).toContain('<meta property="og:image" content="https://example.com/og.png">')
    expect(head).toContain('<meta property="og:locale" content="en_GB">')
    expect(head).toContain('<meta name="twitter:site" content="@kay">')
    expect(head).toContain('<meta name="twitter:card" content="summary_large_image">')
    // Its size read from the public file, its alt text from the config.
    expect(head).toContain('<meta property="og:image:width" content="1000"><meta property="og:image:height" content="600">')
    expect(head).toContain('<meta property="og:image:alt" content="The kay site">')
    expect(head).toContain('<meta name="twitter:image:alt" content="The kay site">')
  })

  it('gives the image a page sets its own size and alt text, not the site image\'s', async () => {
    const card = (await headOf('/card')).head

    expect(card).toContain('<meta property="og:image:width" content="512"><meta property="og:image:height" content="512">')
    expect(card).toContain('<meta property="og:image:alt" content="The kay mark">')
    expect(card).toContain('<meta name="twitter:image:alt" content="The kay mark">')
    expect((await headOf('/share')).head).toContain('<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">')

    // One whose size is unknown goes without, and without the site image's alt text.
    const custom = (await headOf('/custom')).head

    expect(custom).not.toContain('og:image:width')
    expect(custom).not.toContain('image:alt')
  })

  it('wraps the title a page sets in the template, and repeats its own title and description on its card', async () => {
    const { head } = await headOf('/about')

    expect(head).toContain('<title>About | Kay site</title>')
    expect(head).toContain('<meta property="og:title" content="About">')
    expect(head).toContain('<meta name="description" content="Who we are">')
    expect(head).toContain('<meta property="og:description" content="Who we are">')
    expect(head).toContain('<link rel="canonical" href="https://example.com/about">')
    expect(count(head, 'name="description"')).toBe(1)
  })

  it('writes a title marked raw as it is, from the page or a layout, a page\'s plain title still wrapped over it', async () => {
    const welcome = (await headOf('/welcome')).head

    expect(welcome).toContain('<title>Kay, a site with its name first</title>')
    expect(welcome).toContain('<meta property="og:title" content="Kay, a site with its name first">')
    expect(welcome).not.toContain('raw')
    expect((await headOf('/raw')).head).toContain('<title>The raw section</title>')
    expect((await headOf('/raw/plain')).head).toContain('<title>Plain | Kay site</title>')
    expect((await headOf('/raw/off')).head).toContain('<title>Not raw | Kay site</title>')
  })

  it('sets the attributes of <html> a layout gives, from its server data too, the page\'s winning, its class tokens joining theirs, and naming them for the page swap', async () => {
    const themed = await (await app.handle(new Request('http://localhost/themed'))).text()
    const dark = await (await app.handle(new Request('http://localhost/themed/dark'))).text()

    expect(themed).toStartWith('<!doctype html><html lang="en" class="dark" data-theme="light" data-section="home" data-banner><head>')
    expect(themed).toContain('<meta name="kay-html" content="{&quot;class&quot;:&quot;dark&quot;,&quot;data-theme&quot;:&quot;light&quot;,&quot;data-section&quot;:&quot;home&quot;,&quot;data-banner&quot;:&quot;&quot;}">')
    expect(dark).toStartWith('<!doctype html><html lang="en" class="dark wide" data-theme="dark" data-section="dark" data-case="lower"><head>')
    expect(dark).toContain('<meta name="kay-html" content="{&quot;class&quot;:&quot;dark wide&quot;,&quot;data-theme&quot;:&quot;dark&quot;,&quot;data-section&quot;:&quot;dark&quot;,&quot;data-case&quot;:&quot;lower&quot;}">')
    expect((await headOf('/about')).head).not.toContain('kay-html')
  })

  it('shows the site name for a title that comes out empty, not the template around nothing', async () => {
    expect((await headOf('/blank')).head).toContain('<title>Kay site</title>')
  })

  it('lets a page replace the canonical link and its card, made absolute against the site', async () => {
    const { head } = await headOf('/custom?ref=mail')

    expect(head).toContain('<link rel="canonical" href="https://example.com/about">')
    expect(count(head, 'rel="canonical"')).toBe(1)
    expect(head).toContain('<meta property="og:url" content="https://example.com/about">')
    expect(head).toContain('<meta property="og:image" content="https://example.com/custom.png">')
    expect(head).toContain('<meta property="og:title" content="Its own card">')
    expect(count(head, 'og:image')).toBe(1)
    expect(count(head, 'og:title')).toBe(1)
  })

  it('writes JSON-LD with no markup able to end its script', async () => {
    const { head } = await headOf('/custom')
    const scripts = [...head.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map(match => match[1]!)

    expect(scripts).toHaveLength(2)
    expect(scripts.map(script => JSON.parse(script) as { name: string }).map(data => data.name)).toEqual(['Kay </script> site', 'Shop </script><!-- here'])
    expect(scripts.join('')).not.toContain('<')
  })

  it('puts JSON-LD in the schema.org context unless it names its own, several things in one graph', () => {
    expect(JSON.parse(jsonLd({ '@type': 'Person', 'name': 'Ada' }))).toEqual({ '@context': 'https://schema.org', '@type': 'Person', 'name': 'Ada' })
    expect((JSON.parse(jsonLd({ '@context': 'https://example.com/vocab', '@type': 'Thing' })) as Record<string, unknown>)['@context']).toBe('https://example.com/vocab')
    expect(JSON.parse(jsonLd([{ '@type': 'WebSite' }, { '@type': 'Organization' }]))).toEqual({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebSite' }, { '@type': 'Organization' }] })
  })

  it('asks search engines to leave out a page exporting noindex', async () => {
    expect((await headOf('/legal')).head).toContain('<meta name="robots" content="noindex">')
    expect((await headOf('/about')).head).not.toContain('name="robots"')
  })

  it('gives a breadcrumb trail its BreadcrumbList and the site\'s URLs from site, and marks the links to the page shown', async () => {
    const html = await (await app.handle(new Request('http://localhost/trail'))).text()

    expect(html).toContain('{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Home","item":"https://example.com/"},{"@type":"ListItem","position":2,"name":"Trail","item":"https://example.com/trail"}]}')
    expect(html).toContain('<p class="share">https://example.com/trail</p>')
    expect(html).toContain('<nav><a href="/">Home</a><a href="/trail/" aria-current="page">Trail</a><a href="/trail?tab=2">Tab</a><a href="/trail#end">End</a><a href="/trail" aria-current="step">Step</a></nav>')
  })

  it('gives an error page no canonical URL', async () => {
    const { status, head } = await headOf('/missing')

    expect(status).toBe(404)
    expect(head).not.toContain('rel="canonical"')
    expect(head).not.toContain('og:url')
    expect(head).toContain('<title>Kay site</title>')
  })

  it('leaves the head alone when the project sets neither site nor seo', async () => {
    const plain = await pages({ routes: ROUTES, prebuilt: false })
    const html = await (await plain.handle(new Request('http://localhost/about'))).text()

    expect(html).toContain('<title>About</title>')
    expect(html).not.toContain('og:')
    expect(html).not.toContain('canonical')
  })

  it('takes an origin as the site, and refuses a path or a scheme other than http', () => {
    expect(siteOrigin('https://Example.com/')).toBe('https://example.com')
    expect(() => siteOrigin('https://example.com/blog')).toThrow('kay: site is the origin')
    expect(() => siteOrigin('ftp://example.com')).toThrow('kay: site is the origin')
    expect(() => siteOrigin('example.com')).toThrow('kay: site is the origin')
  })

  it('reads the site from SITE_URL when the project leaves it out, its origin alone from siteOrigin()', async () => {
    const before = process.env.SITE_URL

    process.env.SITE_URL = 'https://preview.example.com'

    try {
      const preview = await pages({ routes: ROUTES, prebuilt: false, base: '/kay' })
      const html = await (await preview.handle(new Request('http://localhost/about'))).text()

      expect(html).toContain('<link rel="canonical" href="https://preview.example.com/kay/about">')
      expect(siteUrl('/contact')).toBe('https://preview.example.com/kay/contact')
      expect(currentSiteOrigin()).toBe('https://preview.example.com')

      // What the config sets wins.
      await pages({ routes: ROUTES, prebuilt: false, site: 'https://example.com' })

      expect(currentSiteOrigin()).toBe('https://example.com')
    }
    finally {
      if (before === undefined)
        delete process.env.SITE_URL
      else
        process.env.SITE_URL = before
    }
  })
})

describe('sitemap and robots', () => {
  const LOC = /<loc>(.*?)<\/loc>/g

  it('lists every page a crawler reaches, params from sitemap or prerender, guarded pages only when they opt in', async () => {
    const response = await app.handle(new Request('http://localhost/sitemap.xml'))
    const xml = await response.text()

    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(xml).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect([...xml.matchAll(LOC)].map(match => match[1]).sort()).toEqual([
      'https://example.com/',
      'https://example.com/about',
      'https://example.com/blank',
      'https://example.com/blog/a%20%26%20b',
      'https://example.com/blog/first',
      'https://example.com/card',
      'https://example.com/custom',
      'https://example.com/docs/guide/start',
      'https://example.com/members',
      'https://example.com/missing',
      'https://example.com/share',
      'https://example.com/trail',
    ])
  })

  it('points crawlers at the sitemap', async () => {
    const response = await app.handle(new Request('http://localhost/robots.txt'))

    expect(await response.text()).toBe('User-agent: *\nAllow: /\n\nSitemap: https://example.com/sitemap.xml\n')
  })

  it('leaves both to a public file of the same name, and serves neither without a site', async () => {
    const own = await pages({ routes: ROUTES, publicDir: 'tests/fixtures/seo/public', prebuilt: false, site: 'https://example.com' })
    const plain = await pages({ routes: ROUTES, prebuilt: false })

    expect(await (await own.handle(new Request('http://localhost/robots.txt'))).text()).toBe('User-agent: *\nDisallow: /private\n')
    expect((await own.handle(new Request('http://localhost/sitemap.xml'))).status).toBe(200)
    expect((await plain.handle(new Request('http://localhost/sitemap.xml'))).status).toBe(404)
    expect((await plain.handle(new Request('http://localhost/robots.txt'))).status).toBe(404)
  })
})
