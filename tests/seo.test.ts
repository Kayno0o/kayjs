import { describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { siteOrigin } from '../src/server/seo'

const ROUTES = 'tests/fixtures/seo/src/routes'
const HEAD = /<head>([\s\S]*)<\/head>/

const app = await pages({
  routes: ROUTES,
  prebuilt: false,
  site: 'https://example.com/',
  seo: {
    name: 'Kay site',
    titleTemplate: '%s | Kay site',
    description: 'A site built with kay',
    image: '/og.png',
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
})
