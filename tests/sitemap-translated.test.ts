import type { ServedRoute } from '../src/server/guards'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { sitemapXml } from '../src/server/sitemap'
import { scratchDir } from './scratch'

let count = 0
const SETTINGS = { locales: ['en', 'fr', 'de'], defaultLocale: 'en', prefixDefault: false }

async function sitemapOf(entries: { slug: string, translationKey?: string }[]): Promise<string[]> {
  const file = join(await scratchDir('sitemap-translated-'), 'page.ts')

  count++
  const items = entries.map(({ slug, translationKey }) => `{ slug: '${slug}', data: { title: 'x'${translationKey === undefined ? '' : `, translationKey: '${translationKey}'`} } }`).join(', ')

  await Bun.write(file, `import { s } from 'kay'\nimport { collection } from 'kay/content'\n\nexport const page = { sitemap: collection({ name: 'sitemap-translated-${count}', load: () => [${items}] }, { schema: s.Object({ title: s.String(), translationKey: s.Optional(s.String()) }), localized: true }) }\n`)
  const route = { pattern: '/blog/:slug', params: ['slug'], file, layouts: [], guards: [] } as unknown as ServedRoute

  return [...(await sitemapXml([route], 'https://x.example', undefined, SETTINGS)).matchAll(/<url>.*?<\/url>/g)].map(match => match[0])
}

describe('the sitemap of a localized collection whose translations have slugs of their own', () => {
  it('lists each translation at its own url, every copy linking the others at theirs', async () => {
    const urls = await sitemapOf([
      { slug: 'en/hello', translationKey: 'greeting' },
      { slug: 'fr/bonjour', translationKey: 'greeting' },
    ])
    const alternates = '<xhtml:link rel="alternate" hreflang="en" href="https://x.example/blog/hello"/><xhtml:link rel="alternate" hreflang="fr" href="https://x.example/fr/blog/bonjour"/><xhtml:link rel="alternate" hreflang="de" href="https://x.example/de/blog/hello"/><xhtml:link rel="alternate" hreflang="x-default" href="https://x.example/blog/hello"/>'

    expect(urls.toSorted()).toEqual([
      `<url><loc>https://x.example/blog/hello</loc>${alternates}</url>`,
      `<url><loc>https://x.example/de/blog/hello</loc>${alternates}</url>`,
      `<url><loc>https://x.example/fr/blog/bonjour</loc>${alternates}</url>`,
    ])
  })

  it('lists a translation whose default locale has no entry at its own url, once', async () => {
    const urls = await sitemapOf([
      { slug: 'fr/bonjour', translationKey: 'greeting' },
      { slug: 'de/hallo', translationKey: 'greeting' },
    ])

    const alternates = '<xhtml:link rel="alternate" hreflang="fr" href="https://x.example/fr/blog/bonjour"/><xhtml:link rel="alternate" hreflang="de" href="https://x.example/de/blog/hallo"/>'

    expect(urls).toEqual([`<url><loc>https://x.example/fr/blog/bonjour</loc>${alternates}</url>`, `<url><loc>https://x.example/de/blog/hallo</loc>${alternates}</url>`])
  })

  it('keeps entries that share their slug as they were', async () => {
    const urls = await sitemapOf([{ slug: 'en/hello' }, { slug: 'fr/hello' }])

    expect(urls).toHaveLength(3)
    expect(urls[1]).toContain('<loc>https://x.example/fr/blog/hello</loc>')
  })
})
