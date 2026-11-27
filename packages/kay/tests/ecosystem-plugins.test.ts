import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icons } from '../../plugin-icons/src/plugin'
import { images } from '../../plugin-images/src/index'
import type { MailerOptions } from '../../plugin-mail/src/index'
import { createMailer, MailNotConfiguredError } from '../../plugin-mail/src/index'
import { seo } from '../../plugin-seo/src/index'
import { build } from '../src/build/index'
import { testApp } from '../src/test/index'

const ICONS_PKG = join(import.meta.dir, '../../plugin-icons/src/index.ts')
const IMAGES_PKG = join(import.meta.dir, '../../plugin-images/src/index.ts')
const SEO_PKG = join(import.meta.dir, '../../plugin-seo/src/index.ts')

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

describe('Ecosystem plugins (@kayjs/icons, @kayjs/images, @kayjs/seo, @kayjs/mail)', () => {
  it('composes icons, responsive AVIF/WebP images, SEO/fonts/sitemap/redirects, and mail outbox with 0 KB core leaks', async () => {
    const dir = makeTemp('kay-eco-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/assets'), { recursive: true })

    // Create a real 800x600 PNG via magick, a tiny SVG favicon, and a dummy woff2 font file
    const heroPath = join(dir, 'src/assets/hero.png')
    const mk = Bun.spawnSync(['magick', '-size', '800x600', 'gradient:#c2593f-#2b5876', heroPath])
    expect(mk.exitCode).toBe(0)
    writeFileSync(join(dir, 'src/assets/favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#c2593f"/></svg>')
    writeFileSync(join(dir, 'src/assets/inter-400.woff2'), new Uint8Array([0x77, 0x4F, 0x46, 0x32, 0x00, 0x01, 0x00, 0x00]))

    const contactMailer = createMailer({ from: 'site@example.test', to: 'owner@example.test', optional: true })

    const customIcons = icons({
      sets: {
        demo: {
          prefix: 'demo',
          width: 24,
          height: 24,
          icons: {
            arrow: { body: '<path d="M5 12h14m-6-6l6 6-6 6"/>' },
          },
          aliases: {
            'arrow-left': { parent: 'arrow', hFlip: true },
          },
        },
      },
    })

    const imagePlugin = images({ widths: [320, 640], formats: ['avif', 'webp'], quality: 75, avifQuality: 50 })

    const seoPlugin = seo({
      site: 'https://example.test',
      name: 'Artisan Demo',
      titleTemplate: '%s | Artisan Demo',
      description: 'Peinture et rénovation',
      image: '/og.jpg',
      imageAlt: 'Artisan Demo',
      locale: 'fr_FR',
      favicon: 'src/assets/favicon.svg',
      manifest: { shortName: 'Artisan', themeColor: '#c2593f', backgroundColor: '#ffffff' },
      fonts: [
        { family: 'Inter', src: 'src/assets/inter-400.woff2', weight: 400 },
      ],
      jsonLd: [{ '@type': 'LocalBusiness', 'name': 'Artisan Demo' }],
      redirects: {
        '/old-services': '/services',
        '/promo': { to: '/services', status: 307 },
      },
    })


    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Head } from '@kayjs/kay'
      import { Icon } from ${JSON.stringify(ICONS_PKG)}
      import { image, Picture } from ${JSON.stringify(IMAGES_PKG)}
      import { jsonLd } from ${JSON.stringify(SEO_PKG)}
      import arrow from '~icons/demo/arrow'
      import back from '~icons/demo/arrow-left'
      import hero from '../assets/hero.png'

      export default async function Home() {
        return (
          <main>
            <Head>
              <title>Accueil</title>
              {jsonLd({ '@type': 'BreadcrumbList', name: 'Home' })}
            </Head>
            <h1>Artisan</h1>
            <Icon icon={arrow} class="size-4" />
            <Icon icon={back} class="size-4" aria-label="Retour" />
            <img {...image(hero, { sizes: '50vw', priority: true })} alt="Chantier" />
            <Picture src={hero} alt="Chantier AVIF" sizes="100vw" class="hero-pic" />
          </main>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/services.tsx'), `
      import { Head } from '@kayjs/kay'
      export default async function Services() {
        return (
          <main>
            <Head><title>Services</title></Head>
            <h1>Services</h1>
          </main>
        )
      }
    `)

    const plugins = [customIcons, imagePlugin, seoPlugin, contactMailer]
    const t0 = performance.now()
    const manifest = await build({ root: dir, plugins, static: true })
    const coldMs = performance.now() - t0

    // Zero client JS shipped on static pages using icons + images + seo!
    expect(manifest.runtimeScript).toBeUndefined()

    // Image variants emitted as immutable build assets & copied in --static
    const avifAssets = manifest.assets.filter(a => a.startsWith('img/') && a.endsWith('.avif'))
    const webpAssets = manifest.assets.filter(a => a.startsWith('img/') && a.endsWith('.webp'))
    expect(avifAssets.length).toBe(3) // 320w, 640w, 800w
    expect(webpAssets.length).toBe(3)
    expect(existsSync(join(dir, 'dist/_kay', avifAssets[0]!))).toBe(true)

    // Fonts emitted as immutable assets + @font-face stylesheet
    expect(manifest.assets.some(a => a.startsWith('fonts/') && a.endsWith('.woff2'))).toBe(true)
    expect(manifest.styles.some(s => s.includes('fonts-'))).toBe(true)

    // Public SEO files emitted
    expect(manifest.publicFiles).toContain('sitemap.xml')
    expect(manifest.publicFiles).toContain('manifest.webmanifest')
    expect(manifest.publicFiles).toContain('favicon.svg')

    // Plant a stale file in .kay-cache/images/ and verify second build hits cache AND prunes stale files!
    const staleCacheFile = join(dir, '.kay-cache/images/stale-old-variant.webp')
    writeFileSync(staleCacheFile, 'stale')
    expect(existsSync(staleCacheFile)).toBe(true)

    const t1 = performance.now()
    await build({ root: dir, plugins })
    const warmMs = performance.now() - t1
    expect(warmMs).toBeLessThan(coldMs + 200)
    expect(existsSync(staleCacheFile)).toBe(false)

    const app = await testApp({ root: dir, plugins, prebuilt: true })

    // Verify rendered HTML
    const homeRes = await app.get('/')
    expect(homeRes.status).toBe(200)
    const html = await homeRes.text()
    expect(html).not.toContain('<script type="module"')
    expect(html).toContain('<title>Accueil | Artisan Demo</title>')
    expect(html).toContain('<link rel="canonical" href="https://example.test/">')
    expect(html).toContain('meta name="description" content="Peinture et rénovation"')
    expect(html).toContain('application/ld+json')
    expect(html).toContain('LocalBusiness')
    expect(html).toContain('BreadcrumbList')
    expect(html).toContain('<link rel="preload" href="/_kay/fonts/')
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">')
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    // Inline SVG icons (including flipped alias!)
    expect(html).toContain('<path d="M5 12h14m-6-6l6 6-6 6"/>')
    expect(html).toContain('scale(-1 1)')
    expect(html).toContain('aria-label="Retour"')
    // Responsive <img> + <picture> with AVIF & WebP srcset
    expect(html).toContain('fetchpriority="high"')
    expect(html).toContain('type="image/avif"')
    expect(html).toContain('type="image/webp"')
    expect(html).toContain('320w')
    expect(html).toContain('640w')
    expect(html).toContain('800w')

    // Verify AVIF & font assets serve with correct MIME
    const avifRes = await app.get(`/_kay/${avifAssets[0]}`)
    expect(avifRes.status).toBe(200)
    expect(avifRes.headers.get('content-type')).toBe('image/avif')
    expect(avifRes.headers.get('cache-control')).toContain('immutable')

    // Verify sitemap, manifest, redirects
    const sitemapRes = await app.get('/sitemap.xml')
    expect(sitemapRes.status).toBe(200)
    const sitemap = await sitemapRes.text()
    expect(sitemap).toContain('<loc>https://example.test/</loc>')
    expect(sitemap).toContain('<loc>https://example.test/services</loc>')

    const manifestRes = await app.get('/manifest.webmanifest')
    expect(manifestRes.status).toBe(200)
    expect((await manifestRes.json() as { short_name: string }).short_name).toBe('Artisan')

    const redir1 = await app.get('/old-services')
    expect(redir1.status).toBe(301)
    expect(redir1.headers.get('location')).toBe('/services')

    const redir2 = await app.get('/promo')
    expect(redir2.status).toBe(307)
    expect(redir2.headers.get('location')).toBe('/services')

    // Verify @kayjs/mail send + /_kay/mail preview + JSON outbox
    await contactMailer.send({
      replyTo: { name: 'Marie', address: 'marie@example.test' },
      subject: 'Demande de devis',
      text: 'Bonjour, je souhaite un devis.',
    })
    expect(contactMailer.outbox.length).toBe(1)

    const mailHtml = await (await app.get('/_kay/mail')).text()
    expect(mailHtml).toContain('Demande de devis')
    expect(mailHtml).toContain('marie@example.test')

    // A mail's HTML is shown in a sandboxed frame, never inlined into the preview page
    await contactMailer.send({ subject: 'Rich', html: '<b>bold</b><script>alert(1)</script>' })
    const richHtml = await (await app.get('/_kay/mail')).text()
    expect(richHtml).not.toContain('<script>alert(1)</script>')
    expect(richHtml).toContain('<iframe sandbox="" srcdoc="&lt;b&gt;bold&lt;/b&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')

    const mailJson = await (await app.get('/_kay/mail.json')).json() as { count: number, messages: { subject: string }[] }
    expect(mailJson.count).toBe(2)
    expect(mailJson.messages[1]!.subject).toBe('Demande de devis')
  })

  it('enforces MailNotConfiguredError in production when required and delegates to custom transport', async () => {
    const delivered: string[] = []
    const custom = createMailer({
      from: 'a@b.test',
      to: 'c@d.test',
      transport: {
        async send(m) {
          delivered.push(`${m.from}->${m.to.join(',')}:${m.subject}`)
        },
      },
    })
    await custom.send({ subject: 'Hello', text: 'World' })
    expect(delivered).toEqual(['a@b.test->c@d.test:Hello'])

    const prevEnv = process.env.NODE_ENV
    const prevDev = process.env.KAY_DEV
    process.env.NODE_ENV = 'production'
    delete process.env.KAY_DEV
    try {
      const strict = createMailer({ optional: false })
      await expect(strict.send({ subject: 'Fail', to: 'c@d.test' })).rejects.toBeInstanceOf(MailNotConfiguredError)

      // The mailer's preview is never mounted in production
      const dir = makeTemp('kay-mail-prod-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), `export default async function Home() { return <h1>Prod</h1> }`)
      const configured = { from: 'a@b.test', transport: { async send() {} } }
      const prodApp = await testApp({ root: dir, plugins: [createMailer(configured)] })
      expect((await prodApp.get('/_kay/mail')).status).toBe(404)
      expect((await prodApp.get('/_kay/mail.json')).status).toBe(404)

      // An untyped config passing preview: true still mounts nothing in production
      const forced = createMailer({ ...configured, preview: true } as unknown as MailerOptions)
      const forcedApp = await testApp({ root: dir, plugins: [forced] })
      expect((await forcedApp.get('/_kay/mail')).status).toBe(404)
      expect((await forcedApp.get('/_kay/mail.json')).status).toBe(404)

      // Mail a transport delivered in production is not kept in memory
      const delivering = createMailer({ transport: { async send() {} } })
      await delivering.send({ subject: 'Sign-in link', to: 'c@d.test', text: 'https://example.test/auth/magic?token=secret' })
      expect(delivering.outbox).toEqual([])
    }
    finally {
      if (prevEnv === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = prevEnv
      if (prevDev !== undefined)
        process.env.KAY_DEV = prevDev
    }
  })
})
