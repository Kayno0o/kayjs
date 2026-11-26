import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, memoryAuthStore } from '../../plugin-auth/src/index'
import { content, defineCollection } from '../../plugin-content/src/index'
import { i18n } from '../../plugin-i18n/src/index'
import { images, shareCard } from '../../plugin-images/src/index'
import { seo } from '../../plugin-seo/src/index'
import { build } from '../src/build/index'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Shared site, locales, proxy trust & localized sitemap (#3551)', () => {
  it('propagates KayConfig.site and active locales to i18n, seo, content, and images without repetition', async () => {
    const dir = makeTemp('kay-shared-site-')
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })
    mkdirSync(join(dir, 'src/content/posts/fr'), { recursive: true })
    mkdirSync(join(dir, 'src/content/posts/en'), { recursive: true })

    writeFileSync(join(dir, 'src/content/posts/fr/hello.md'), '---\ntitle: Bonjour\ndate: 2026-01-01\n---\nSalut\n')
    writeFileSync(join(dir, 'src/content/posts/en/hello.md'), '---\ntitle: Hello\ndate: 2026-01-01\n---\nHi\n')

    const posts = defineCollection({
      dir: join(dir, 'src/content/posts'),
      localized: true,
      // Intentionally omit `defaultLocale` — must inherit `'fr'` from active @kayjs/i18n!
    })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export const prerender = true
      export default function Home({ locals }: { locals: { locale?: string } }) {
        return <h1>Home {locals.locale}</h1>
      }
    `)
    writeFileSync(join(dir, 'src/routes/about.tsx'), `
      export default function About() {
        return <h1>About</h1>
      }
    `)
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
      export const prerender = true
      export function paths() { return ['/posts/hello'] }
      export default function Post({ params }: { params: { slug: string } }) {
        return <h1>Post {params.slug}</h1>
      }
    `)

    let cardUrl = ''
    writeFileSync(join(dir, 'src/routes/card.tsx'), `
      export async function GET() {
        return new Response('ok')
      }
    `)

    const plugins = [
      images({ card: { background: '#111' } }),
      i18n({ locales: ['fr', 'en'], defaultLocale: 'fr' }),
      content({
        feeds: [
          { path: '/rss.xml', title: 'Blog', description: 'Posts', collection: posts, linkPrefix: '/posts' },
        ],
      }),
      seo({ name: 'Demo', description: { fr: 'Desc FR', en: 'Desc EN' } }),
    ]

    await build({
      root: dir,
      site: 'https://demo.example.com/',
      plugins,
      minify: false,
    })

    // 1. Sitemap automatically includes localized static + prerendered paths with xhtml:link hreflang alternates — no extraUrls!
    const sitemap = readFileSync(join(dir, 'dist/public/sitemap.xml'), 'utf8')
    expect(sitemap).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(sitemap).toContain('<loc>https://demo.example.com/</loc>')
    expect(sitemap).toContain('<loc>https://demo.example.com/en</loc>')
    expect(sitemap).toContain('<loc>https://demo.example.com/about</loc>')
    expect(sitemap).toContain('<loc>https://demo.example.com/en/about</loc>')
    expect(sitemap).toContain('<loc>https://demo.example.com/posts/hello</loc>')
    expect(sitemap).toContain('<loc>https://demo.example.com/en/posts/hello</loc>')
    expect(sitemap).toContain('<xhtml:link rel="alternate" hreflang="fr" href="https://demo.example.com/about"/>')
    expect(sitemap).toContain('<xhtml:link rel="alternate" hreflang="en" href="https://demo.example.com/en/about"/>')

    // 2. RSS feed inherited `site` from core AND `defaultLocale: 'fr'` from i18n
    const rss = readFileSync(join(dir, 'dist/public/rss.xml'), 'utf8')
    expect(rss).toContain('<link>https://demo.example.com</link>')
    expect(rss).toContain('<title>Bonjour</title>')
    expect(rss).toContain('<link>https://demo.example.com/posts/hello</link>')

    // 3. Server runtime: canonical, i18n hreflang, and shareCard all inherit core `site`
    const app = await testApp({
      root: dir,
      prebuilt: true,
      site: 'https://demo.example.com',
      plugins: [
        ...plugins,
        {
          name: 'card-probe',
          server(api) {
            api.route('GET', '/_probe-card', (ctx) => {
              cardUrl = shareCard({ title: 'Inherited Site' })
              return ctx.text(cardUrl)
            })
          },
        },
      ],
    })

    const homeHtml = await (await app.get('/')).text()
    expect(homeHtml).toContain('<link rel="canonical" href="https://demo.example.com/">')
    expect(homeHtml).toContain('<link rel="alternate" hreflang="fr" href="https://demo.example.com/">')
    expect(homeHtml).toContain('<link rel="alternate" hreflang="en" href="https://demo.example.com/en">')

    const enAboutHtml = await (await app.get('/en/about')).text()
    expect(enAboutHtml).toContain('<link rel="canonical" href="https://demo.example.com/en/about">')
    expect(enAboutHtml).toContain('content="Desc EN"')

    const cardRes = await (await app.get('/_probe-card')).text()
    expect(cardRes.startsWith('https://demo.example.com/og/')).toBe(true)
  })

  it('auth inherits site, trustProxy, and trustedOrigins from core config', async () => {
    const dir = makeTemp('kay-shared-auth-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }\n')

    const mailed: string[] = []
    const auth = createAuth({
      store: memoryAuthStore(),
      secret: 'test-secret-for-shared-config-at-least-32-bytes',
      sendMail(m) {
        mailed.push(m.url)
      },
    })

    const app = await testApp({
      root: dir,
      site: 'https://auth.example.com',
      trustProxy: true,
      trustedOrigins: ['https://partner.example.com'],
      plugins: [auth],
    })

    // Cross-origin POST from core `trustedOrigins` is accepted on auth route without redeclaring in createAuth()
    const res = await app.fetch(new Request('https://auth.example.com/auth/magic-link', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json',
        'origin': 'https://partner.example.com',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ email: 'alice@example.com' }),
    }))
    expect(res.status).toBe(200)
    expect(mailed.length).toBe(1)
    expect(mailed[0]!.startsWith('https://auth.example.com/auth/magic-link/verify?token=')).toBe(true)
  })
})
