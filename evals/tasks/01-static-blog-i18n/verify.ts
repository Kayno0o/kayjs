import type { AssertionResult, VerifyContext } from '../../lib/types'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assert, AssertionCollector, extractLinks, readAppSourceFiles } from '../../lib/assertions'

export async function verify({ dir, app, bundleReport }: VerifyContext): Promise<AssertionResult[]> {
  const c = new AssertionCollector()

  let enHomeHtml = ''
  await c.run('GET / returns 200 with lang="en" and blog links', async () => {
    const res = await app.get('/')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    enHomeHtml = await res.text()
    assert(/<html\b[^>]*\blang=["']en["']/i.test(enHomeHtml), 'missing <html lang="en">')
    assert(!/<script\b[^>]*src=["']\/_kay\/[^"']+\.js["']/i.test(enHomeHtml), 'unexpected client JS script tag on 0 KB page')
    const blogLinks = extractLinks(enHomeHtml).filter(href => href.startsWith('/blog/'))
    assert(blogLinks.length >= 1, 'home page must link to at least one /blog/<slug> post')
    return `${blogLinks.length} blog links`
  })

  await c.run('GET /fr returns 200 with lang="fr" and localized content', async () => {
    const res = await app.get('/fr')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const frHtml = await res.text()
    assert(/<html\b[^>]*\blang=["']fr["']/i.test(frHtml), 'missing <html lang="fr">')
    assert(frHtml !== enHomeHtml, 'French page HTML is identical to English page')
  })

  await c.run('GET /_i18n/locales exposes en and fr', async () => {
    const res = await app.get('/_i18n/locales')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const body = await res.json() as { locales?: string[], defaultLocale?: string }
    assert(Array.isArray(body.locales) && body.locales.includes('en') && body.locales.includes('fr'), `unexpected locales: ${JSON.stringify(body)}`)
  })

  await c.run('localized blog posts render in en and fr and 404 when missing', async () => {
    const blogLink = extractLinks(enHomeHtml).find(href => href.startsWith('/blog/'))
    assert(blogLink !== undefined, 'no /blog/<slug> link found on /')

    const enPost = await app.get(blogLink)
    assert(enPost.status === 200, `expected 200 for ${blogLink}, got ${enPost.status}`)
    const enPostHtml = await enPost.text()
    assert(/<h1\b/i.test(enPostHtml) && /<p\b/i.test(enPostHtml), 'post page missing rendered heading/paragraph')

    const frPost = await app.get(`/fr${blogLink}`)
    assert(frPost.status === 200, `expected 200 for /fr${blogLink}, got ${frPost.status}`)
    const frPostHtml = await frPost.text()
    assert(/<html\b[^>]*\blang=["']fr["']/i.test(frPostHtml), `missing lang="fr" on /fr${blogLink}`)

    const missing = await app.get('/blog/this-slug-definitely-does-not-exist')
    assert(missing.status === 404, `expected 404 for unknown slug, got ${missing.status}`)
  })

  await c.run('GET /rss.xml serves valid RSS feed with items', async () => {
    const res = await app.get('/rss.xml')
    assert(res.status === 200, `expected 200, got ${res.status}`)
    const ct = res.headers.get('content-type') ?? ''
    assert(/xml/i.test(ct), `expected XML content-type, got "${ct}"`)
    const xml = await res.text()
    assert(xml.includes('<rss') && xml.includes('<item>'), 'RSS XML missing <rss> or <item> entries')
  })

  await c.run('posts route is prerendered and ships 0 B eager JS', async () => {
    const manifestPath = join(dir, 'dist/manifest.json')
    assert(existsSync(manifestPath), 'dist/manifest.json missing')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { routes: Array<{ path: string, prerender?: boolean }> }
    const hasPrerender = manifest.routes.some(r => r.prerender === true)
    assert(hasPrerender, 'no route exports prerender = true')
    if (bundleReport !== undefined) {
      const maxJs = bundleReport.routes.reduce((m, r) => Math.max(m, r.jsGzip), 0)
      assert(maxJs === 0, `expected 0 B eager JS, got ${maxJs} B`)
    }
  })

  await c.run('uses Standard Schema frontmatter validation', async () => {
    const sources = [...readAppSourceFiles(dir).values()].join('\n')
    const hasSchema = sources.includes('~standard') || /\bschema\s*:/.test(sources)
    assert(hasSchema, 'no Standard Schema frontmatter configuration detected in src/')
  })

  return c.results
}
