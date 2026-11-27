import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuth, memoryAuthStore } from '../../plugin-auth/src/index'
import { content, defineCollection } from '../../plugin-content/src/index'
import { i18n } from '../../plugin-i18n/src/index'
import { images } from '../../plugin-images/src/plugin'
import { createMailer } from '../../plugin-mail/src/index'
import { mcp } from '../../plugin-mcp/src/index'
import { seo } from '../../plugin-seo/src/index'
import { build, createBuildCache } from '../src/build/index'
import { definePlugin } from '../src/plugins/index'
import { createServer } from '../src/server/index'
import { testApp } from '../src/test/index'

const CONTENT_PKG = join(import.meta.dir, '../../plugin-content/src/index.ts')
const IMAGES_PKG = join(import.meta.dir, '../../plugin-images/src/index.ts')

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

describe('a throwing onError or onShutdown hook (#3584)', () => {
  it('is logged with its owner, and the other hooks still run', async () => {
    const dir = makeTemp('kay-hook-errors-')
    const files: Record<string, string> = {
      'kay.config.ts': `
        const seen = (globalThis as { hookLog?: string[] }).hookLog ??= []
        export default {
          onError() { throw new Error('app hook broke') },
          plugins: [
            { name: 'first', onError() { throw new Error('first broke') }, server(api: any) { api.onShutdown(() => { throw new Error('first shutdown broke') }) } },
            { name: 'second', onError(info: { error: Error }) { seen.push(\`second saw \${info.error.message}\`) }, server(api: any) { api.onShutdown(() => { seen.push('second closed') }) } },
          ],
        }
      `,
      'src/routes/index.ts': 'export function GET(): Response { throw new Error(\'route broke\') }\n',
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    await build({ root: dir })
    const logged: unknown[][] = []
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args) })
    try {
      const app = await createServer({ root: dir })
      expect((await app.handle(new Request('http://localhost/'))).status).toBe(500)
      await app.dispose?.()
    }
    finally {
      spy.mockRestore()
    }
    expect((globalThis as { hookLog?: string[] }).hookLog).toEqual(['second saw route broke', 'second closed'])
    expect(logged.map(([message, error]) => `${String(message)} ${(error as Error).message}`)).toEqual([
      'kay: the onError hook of kay.config.ts threw; the other hooks still run. app hook broke',
      'kay: the onError hook of first threw; the other hooks still run. first broke',
      'kay: the onShutdown hook of first threw; the other hooks still run. first shutdown broke',
    ])
  })
})

describe('KayPlugin lifecycle, build-to-server handoff & HTTP/CSRF precedence (#3566)', () => {
  it('runs afterPrerender after Step 3 so @kayjs/seo sitemap includes dynamic paths() and @kayjs/i18n routes', async () => {
    const dir = makeTemp('kay-seo-sitemap-')
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export const prerender = true
      export default function Home() { return <h1>Home</h1> }
    `)
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), `
      export const prerender = true
      export function paths() { return ['/posts/alpha', '/posts/beta'] }
      export default function Post({ params }: { params: { slug: string } }) {
        return <article><h1>{params.slug}</h1></article>
      }
    `)

    const plugins = [
      i18n({ locales: ['en', 'fr'], defaultLocale: 'en', site: 'https://example.test' }),
      seo({ site: 'https://example.test', name: 'Blog' }),
    ]

    // 1. Standard build (manifest + dist/public/sitemap.xml)
    const manifest = await build({ root: dir, plugins })
    expect(manifest.publicFiles).toContain('sitemap.xml')
    const sitemapBuild = readFileSync(join(dir, 'dist/public/sitemap.xml'), 'utf8')
    expect(sitemapBuild).toContain('<loc>https://example.test/</loc>')
    expect(sitemapBuild).toContain('<loc>https://example.test/fr</loc>')
    expect(sitemapBuild).toContain('<loc>https://example.test/posts/alpha</loc>')
    expect(sitemapBuild).toContain('<loc>https://example.test/posts/beta</loc>')
    expect(sitemapBuild).toContain('<loc>https://example.test/fr/posts/alpha</loc>')
    expect(sitemapBuild).toContain('<loc>https://example.test/fr/posts/beta</loc>')

    // 2. Static export also includes the complete sitemap.xml
    await build({ root: dir, plugins, static: true })
    const sitemapStatic = readFileSync(join(dir, 'dist/sitemap.xml'), 'utf8')
    expect(sitemapStatic).toContain('<loc>https://example.test/posts/alpha</loc>')
    expect(sitemapStatic).toContain('<loc>https://example.test/fr/posts/beta</loc>')
  })

  it('persists @kayjs/images build data for cold-start createServer() and resolves Markdown images + shareCard independent of plugin order', async () => {
    const dir = makeTemp('kay-coldstart-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'content/posts'), { recursive: true })

    // Create a tiny valid PNG (1x1) without requiring external fixtures
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    writeFileSync(join(dir, 'content/posts/hero.png'), pngBytes)
    writeFileSync(join(dir, 'content/posts/hello.md'), '---\ntitle: Cold Start Post\n---\n![Hero](./hero.png)\n')

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { raw } from '@kayjs/kay/internal/ssr'
      import { defineCollection } from ${JSON.stringify(CONTENT_PKG)}
      import { shareCard } from ${JSON.stringify(IMAGES_PKG)}
      const posts = defineCollection({ dir: 'content/posts' })
      export default async function Home() {
        const entry = posts.get('hello')
        const cardUrl = shareCard({ title: 'Cold Card' })
        return (
          <main data-card={cardUrl}>
            {entry ? raw(entry.html) : null}
          </main>
        )
      }
    `)

    // Reversed plugin order: content BEFORE images
    const buildPlugins = [
      content(),
      images({
        widths: [320],
        formats: ['webp'],
        card: { site: 'https://cold.example' },
      }),
    ]
    const manifest = await build({ root: dir, plugins: buildPlugins })
    expect(manifest.pluginData?.['@kayjs/images']).toBeDefined()

    // Simulate a cold-start server with brand-new plugin instances whose build() was NEVER called
    const coldApp = await createServer({
      root: dir,
      plugins: [content(), images()],
    })
    const res = await coldApp.handle(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-card="https://cold.example/og/cold-card-')
    expect(html).toMatch(/<img[^>]+src="\/img\/hero-/)
  })

  it('isolates concurrent multi-root apps without bleeding AppRuntimeContext services or roots', async () => {
    const dirA = makeTemp('kay-multi-a-')
    const dirB = makeTemp('kay-multi-b-')

    for (const [dir, label] of [[dirA, 'Alpha'], [dirB, 'Beta']] as const) {
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      mkdirSync(join(dir, 'content'), { recursive: true })
      writeFileSync(join(dir, 'content/note.md'), `---\ntitle: Note ${label}\n---\nBody ${label}\n`)
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import { defineCollection } from ${JSON.stringify(CONTENT_PKG)}
        import { shareCard } from ${JSON.stringify(IMAGES_PKG)}
        const notes = defineCollection({ dir: 'content' })
        export default async function Page() {
          const all = notes.all()
          const card = shareCard({ title: 'Card' })
          return <p data-card={card}>{all.map(n => n.data.title).join(',')}</p>
        }
      `)
    }

    const [appA, appB] = await Promise.all([
      testApp({ root: dirA, plugins: [images({ card: { site: 'https://alpha.example' } })] }),
      testApp({ root: dirB, plugins: [images({ card: { site: 'https://beta.example' } })] }),
    ])

    const [htmlA, htmlB] = await Promise.all([
      appA.get('/').then(r => r.text()),
      appB.get('/').then(r => r.text()),
    ])

    expect(htmlA).toContain('Note Alpha')
    expect(htmlA).toContain('https://alpha.example/og/')
    expect(htmlB).toContain('Note Beta')
    expect(htmlB).toContain('https://beta.example/og/')
  })

  it('applies transformHtml to _404.tsx and _error.tsx and lets plugin rewrites run before prerendered fast-path', async () => {
    const dir = makeTemp('kay-html-rewrite-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/_404.tsx'), `
      import { Head } from '@kayjs/kay'
      export default function NotFound() {
        return <><Head><title>Missing</title></Head><a href="/home">Back</a></>
      }
    `)
    writeFileSync(join(dir, 'src/routes/_error.tsx'), `
      import { Head } from '@kayjs/kay'
      export default function Err() {
        return <><Head><title>Boom</title></Head><a href="/home">Recover</a></>
      }
    `)
    writeFileSync(join(dir, 'src/routes/crash.tsx'), `
      export default function Crash() {
        throw new Error('intentional')
      }
    `)
    writeFileSync(join(dir, 'src/routes/landing.tsx'), `
      export const prerender = true
      export default function Landing() { return <h1>Original Landing</h1> }
    `)
    writeFileSync(join(dir, 'src/routes/alt.tsx'), `
      export default function Alt() { return <h1>Rewritten Alt</h1> }
    `)

    const rewritePlugin = definePlugin({
      name: 'test-rewrite',
      server(api) {
        api.rewrite((pathname) => {
          if (pathname === '/landing')
            return '/alt'
          return undefined
        })
      },
    })

    const app = await testApp({
      root: dir,
      plugins: [
        i18n({ locales: ['en', 'fr'], defaultLocale: 'en' }),
        seo({ site: 'https://example.test', titleTemplate: '%s — Demo' }),
        rewritePlugin,
      ],
    })

    // 404 page gets i18n lang + link localization + seo titleTemplate
    const res404 = await app.get('/fr/does-not-exist')
    expect(res404.status).toBe(404)
    const html404 = await res404.text()
    expect(html404).toContain('<html lang="fr">')
    expect(html404).toContain('<title>Missing — Demo</title>')
    expect(html404).toContain('href="/fr/home"')

    // 500 error page gets i18n lang + link localization + seo titleTemplate
    const res500 = await app.get('/fr/crash')
    expect(res500.status).toBe(500)
    const html500 = await res500.text()
    expect(html500).toContain('<html lang="fr">')
    expect(html500).toContain('<title>Boom — Demo</title>')
    expect(html500).toContain('href="/fr/home"')

    // Prerendered /landing does NOT bypass rewritePlugin
    const resRewrite = await app.get('/landing')
    expect(resRewrite.status).toBe(200)
    expect(await resRewrite.text()).toContain('Rewritten Alt')
  })

  it('runs plugin.transform on .ts files, invalidates BuildCache on transform changes, and invokes bunPlugins per target', async () => {
    const dir = makeTemp('kay-transform-ts-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/lib'), { recursive: true })

    writeFileSync(join(dir, 'src/lib/msg.ts'), `export const MSG = 'RAW_TS_TOKEN'\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { signal } from '@kayjs/kay'
      import { MSG } from '../lib/msg'
      export default function Home() {
        const clicks = signal(0)
        return <button onClick={() => clicks.value++}>{MSG} / RAW_TSX_TOKEN ({clicks.value})</button>
      }
    `)

    const targets: string[] = []
    const pluginA = definePlugin({
      name: 'transform-a',
      bunPlugins: ({ target }) => {
        targets.push(target)
        return []
      },
      transform(code) {
        return code.replace('RAW_TS_TOKEN', 'TRANSFORMED_TS_A').replace('RAW_TSX_TOKEN', 'TRANSFORMED_TSX_A')
      },
    })

    const cache = createBuildCache()
    const manifestA = await build({ root: dir, plugins: [pluginA], cache })
    expect(targets).toContain('client')
    expect(targets).toContain('server')

    const clientJsA = manifestA.assets
      .filter(f => f.endsWith('.js'))
      .map(f => readFileSync(join(dir, 'dist/client', f), 'utf8'))
      .join('\n')
    expect(clientJsA).toContain('TRANSFORMED_TS_A')
    expect(clientJsA).toContain('TRANSFORMED_TSX_A')

    const appA = await createServer({ root: dir, plugins: [pluginA] })
    const htmlA = await (await appA.handle(new Request('http://localhost/'))).text()
    expect(htmlA).toContain('TRANSFORMED_TS_A')
    expect(htmlA).toContain('TRANSFORMED_TSX_A')

    // Rebuilding with a different transform plugin using the SAME BuildCache must invalidate cached TSX
    const pluginB = definePlugin({
      name: 'transform-b',
      transform(code) {
        return code.replace('RAW_TS_TOKEN', 'TRANSFORMED_TS_B').replace('RAW_TSX_TOKEN', 'TRANSFORMED_TSX_B')
      },
    })
    const manifestB = await build({ root: dir, plugins: [pluginB], cache })
    const clientJsB = manifestB.assets
      .filter(f => f.endsWith('.js'))
      .map(f => readFileSync(join(dir, 'dist/client', f), 'utf8'))
      .join('\n')
    expect(clientJsB).toContain('TRANSFORMED_TS_B')
    expect(clientJsB).toContain('TRANSFORMED_TSX_B')

    const appB = await createServer({ root: dir, plugins: [pluginB] })
    const htmlB = await (await appB.handle(new Request('http://localhost/'))).text()
    expect(htmlB).toContain('TRANSFORMED_TS_B')
    expect(htmlB).toContain('TRANSFORMED_TSX_B')
  })

  it('unifies CSRF for @kayjs/auth trustedOrigins, allows bearer cross-origin @kayjs/mcp, and serves CSP-clean /_kay/mail', async () => {
    const dir = makeTemp('kay-csrf-csp-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), `export default function Home() { return <p>ok</p> }`)

    const auth = createAuth({
      store: memoryAuthStore(),
      secret: 'test-secret-012345678901234567890123',
      requireEmailVerification: false,
      trustedOrigins: ['https://partner.example'],
    })

    const mcpPlugin = mcp({
      token: 'secret-mcp-token-1234',
      tools: {},
    })

    const mail = createMailer({ from: 'test@example.test', to: 'user@example.test', optional: true })
    await mail.send({ subject: 'Hello CSP', text: 'Plain body' })

    const app = await testApp({
      root: dir,
      plugins: [auth, mcpPlugin, mail],
    })

    // 1. @kayjs/auth trustedOrigins works WITHOUT duplicating trustedOrigins in KayConfig
    const authRes = await app.fetch('/auth/signup', {
      method: 'POST',
      headers: {
        'origin': 'https://partner.example',
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({ email: 'alice@example.test', password: 'super-secret-password' }),
    })
    expect(authRes.status).toBe(201)

    // Untrusted origin is still rejected with 403
    const badAuthRes = await app.fetch('/auth/signin', {
      method: 'POST',
      headers: {
        'origin': 'https://evil.example',
        'content-type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify({ email: 'alice@example.test', password: 'super-secret-password' }),
    })
    expect(badAuthRes.status).toBe(403)

    // 2. @kayjs/mcp bearer-authed POST and DELETE succeed even with a cross-origin Origin header
    const mcpPost = await app.fetch('/mcp/tools', {
      method: 'POST',
      headers: {
        'origin': 'https://client-proxy.example',
        'authorization': 'Bearer secret-mcp-token-1234',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    })
    expect(mcpPost.status).toBe(200)

    const mcpDelete = await app.fetch('/mcp/tools', {
      method: 'DELETE',
      headers: {
        'origin': 'https://client-proxy.example',
        'authorization': 'Bearer secret-mcp-token-1234',
      },
    })
    expect(mcpDelete.status).toBe(204)

    // 3. @kayjs/mail /_kay/mail renders without inline style="..." attributes and sets a matching CSP style hash
    const mailRes = await app.get('/_kay/mail')
    expect(mailRes.status).toBe(200)
    const mailHtml = await mailRes.text()
    expect(mailHtml).toContain('Hello CSP')
    expect(mailHtml).not.toContain(' style="')
    const csp = mailRes.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("style-src 'self' 'sha256-")
  })

  it('hashes the <style> blocks of a plugin HTML page into the app CSP, and keeps a CSP the plugin set (#3578)', async () => {
    const dir = makeTemp('kay-plugin-html-csp-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), `export default function Home() { return <p>ok</p> }`)
    const html = { 'content-type': 'text/html; charset=utf-8' }
    const plugin = definePlugin({
      name: 'pages',
      server(api) {
        api.route('GET', '/_pages/styled', () => new Response('<!DOCTYPE html><html><head><style>p{color:red}</style></head><body><p>styled</p></body></html>', { headers: html }))
        api.route('GET', '/_pages/own', () => new Response('<p>own</p>', { headers: { ...html, 'content-security-policy': 'default-src \'none\'' } }))
      },
    })
    const app = await testApp({ root: dir, plugins: [plugin] })

    const styled = await app.get('/_pages/styled')
    expect(styled.headers.get('content-security-policy')).toContain('\'sha256-p0bF+un5yUb9MBO6xRb8kPHlY2BdpHVtLiFkDrZPF64=\'')
    expect(styled.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(await styled.text()).toContain('<p>styled</p>')
    expect((await app.get('/_pages/own')).headers.get('content-security-policy')).toBe('default-src \'none\'')
  })
})

describe('KayPlugin.inlineScripts (#3686)', () => {
  it('allows the inline scripts a plugin declares by hash in the CSP of every page, prerendered or not', async () => {
    const dir = makeTemp('kay-3686-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export const prerender = true\nexport default function Home() { return <p>ok</p> }')
    writeFileSync(join(dir, 'src/routes/live.tsx'), `export default function Live() { return <p>live</p> }`)
    const script = 'document.documentElement.dataset.ok=1'
    const plugin = definePlugin({
      name: 'scripted',
      inlineScripts: [script],
      transformHtml: html => html.replace('</head>', `<script>${script}</script></head>`),
    })
    const app = await testApp({ root: dir, plugins: [plugin] })

    for (const path of ['/', '/live']) {
      const res = await app.get(path)
      expect(await res.text()).toContain(`<script>${script}</script>`)
      expect(res.headers.get('content-security-policy')!.split(';').find(part => part.trim().startsWith('script-src'))).toContain('\'sha256-u3twIN/hbuTtF4dczntgihzKrZIoj3rwsCNTla9zyIA=\'')
    }
  })
})

describe('a throwing plugin build hook (#3657)', () => {
  const hooks = ['build', 'afterPrerender', 'transform', 'prerenderPaths'] as const
  for (const hook of hooks) {
    it(`fails the build naming the plugin and its ${hook} hook, keeping the cause`, async () => {
      const dir = makeTemp(`kay-plugin-${hook}-`)
      mkdirSync(join(dir, 'src', 'routes'), { recursive: true })
      writeFileSync(join(dir, 'src', 'routes', 'index.tsx'), 'export const prerender = true\nexport default function Home() { return <main>ok</main> }')
      const boom = new Error('boom')
      const plugin = definePlugin({ name: 'breaker', [hook]: () => { throw boom } })
      const err = await build({ root: dir, plugins: [plugin] }).then(() => undefined, (e: unknown) => e as Error)
      expect(err?.message).toBe(`kay build: plugin "breaker" ${hook} failed: boom`)
      expect(err?.cause).toBe(boom)
    })
  }
})

describe('KayPlugin.requires: what a plugin needs to run in production (#3674)', () => {
  const needs = (name: string, unmet: string[]) => definePlugin({ name, requires: () => unmet })
  const broken = definePlugin({
    name: 'broken',
    requires() {
      throw new Error('boom')
    },
  })
  const ctx = { root: '/app', site: undefined }

  function appDir(): string {
    const dir = makeTemp('kay-requires-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export const prerender = true\nexport default function Home() { return <h1>Home</h1> }\n')
    return dir
  }

  it('a production start with every requirement met boots', async () => {
    const app = await testApp({ root: appDir(), plugins: [needs('a', [])], nodeEnv: 'production' })
    expect((await app.get('/')).status).toBe(200)
    await app.app.dispose?.()
  })

  it('a production start refuses while two plugins lack something, listing both with their plugin and fix, after a build that went through', async () => {
    const root = appDir()
    const plugins = [needs('a', ['set A']), needs('b', ['set B'])]
    const built = await build({ root, outDir: 'dist-requires', plugins, nodeEnv: 'production' })
    expect(built.routes.find(r => r.path === '/')?.prerendered).toEqual({ '/': 'prerendered/index.html' })
    await expect(createServer({ root, outDir: 'dist-requires', plugins, nodeEnv: 'production' })).rejects.toThrow('kay: the app cannot start in production until its plugins get what they need:\n  - a: set A\n  - b: set B')
  })

  it('kay dev boots with NODE_ENV=production and only warns', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = await testApp({ root: appDir(), plugins: [needs('in-dev', ['set E'])], dev: true, nodeEnv: 'production' })
      expect((await app.get('/')).status).toBe(200)
      expect(warn.mock.calls.filter(c => String(c[0]).includes('in-dev: set E'))).toHaveLength(1)
      await app.app.dispose?.()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('a requires that throws is that plugin\'s error, the other plugins still listed', async () => {
    await expect(testApp({ root: appDir(), plugins: [needs('a', ['set A']), broken], nodeEnv: 'production' })).rejects.toThrow('  - a: set A\n  - broken: requires() threw: boom')
  })

  it('outside production the app boots and warns once per requirement, however many servers start', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const root = appDir()
      const first = await testApp({ root, plugins: [needs('dev-only', ['set D'])] })
      const second = await testApp({ root, prebuilt: true, plugins: [needs('dev-only', ['set D'])] })
      expect((await second.get('/')).status).toBe(200)
      expect(warn.mock.calls.filter(c => String(c[0]).includes('dev-only: set D'))).toEqual([['kay: in production this would refuse to start: dev-only: set D']])
      await first.app.dispose?.()
      await second.app.dispose?.()
    }
    finally {
      warn.mockRestore()
    }
  })

  it('kay check warns about each unmet requirement and reports a throwing requires as an error', async () => {
    const { checkProject } = await import('../src/cli/check')
    const root = appDir()
    writeFileSync(join(root, 'kay.config.ts'), `export default {
      compliance: { legalNotice: false },
      plugins: [
        { name: 'a', requires: () => ['set A'] },
        { name: 'broken', requires: () => { throw new Error('boom') } },
      ],
    }\n`)
    const res = await checkProject(root, { skipTypecheck: true })
    expect(res.warnings.filter(w => w.includes('a: set A'))).toEqual(['kay.config.ts:1:1: warning: a: set A (a production start refuses until it is set)'])
    expect(res.errors.filter(e => e.includes('broken'))).toEqual(['kay.config.ts:1:1: error: broken: requires() threw: boom'])
  })

  it('@kayjs/auth requires a store that outlives the process', async () => {
    const { sqliteAuthStore } = await import('../../plugin-auth/src/sqlite')
    const secret = 'test-secret-012345678901234567890123'
    const message = '`store` keeps accounts and sessions in memory, so a restart signs everyone out and loses every account: pass `store: sqliteAuthStore(\'data/auth.db\')` from `@kayjs/auth/sqlite`, or your own `AuthStore`.'
    expect(await createAuth({ secret }).requires!(ctx)).toEqual([message])
    expect(await createAuth({ secret, store: memoryAuthStore() }).requires!(ctx)).toEqual([message])
    expect(await createAuth({ secret, store: sqliteAuthStore() }).requires!(ctx)).toEqual([message])
    expect(await createAuth({ secret, store: sqliteAuthStore(join(makeTemp('kay-auth-db-'), 'auth.db')) }).requires!(ctx)).toEqual([])
  })

  it('@kayjs/mail requires a transport and a sender, a transport only when mail is not optional', async () => {
    const transport = { async send() {} }
    expect(await createMailer().requires!(ctx)).toEqual([
      'no transport, so every send() throws: set `RESEND_API_KEY`, or pass `transport` to `createMailer()` (`optional: true` drops mail instead).',
      'no sender, so mail goes out from noreply@localhost: set `MAIL_FROM`, or pass `from` to `createMailer()`.',
    ])
    expect(await createMailer({ optional: true, from: 'a@b.test' }).requires!(ctx)).toEqual([])
    expect(await createMailer({ transport, from: 'a@b.test' }).requires!(ctx)).toEqual([])
    const prev = process.env.MAIL_FROM
    process.env.MAIL_FROM = 'env@b.test'
    try {
      expect(await createMailer({ transport }).requires!(ctx)).toEqual([])
    }
    finally {
      if (prev === undefined)
        delete process.env.MAIL_FROM
      else
        process.env.MAIL_FROM = prev
    }
  })

  it('@kayjs/mail refuses a mail with no recipient, naming the call, in development and in production', async () => {
    const mailer = createMailer({ from: 'a@b.test', transport: { async send() {} } })
    const refusal = '@kayjs/mail: send({ subject: "Hi" }) has no recipient: give it `to`, pass `to` to `createMailer()`, or set `MAIL_TO`.'
    await expect(mailer.send({ subject: 'Hi' })).rejects.toThrow(refusal)
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      await expect(mailer.send({ subject: 'Hi' })).rejects.toThrow(refusal)
    }
    finally {
      if (prev === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = prev
    }
  })

  it('@kayjs/mcp requires a token that resolves, @kayjs/seo a site', async () => {
    const noToken = ['no `token`, so the endpoint answers 404 to every call: pass `token: { env: \'MCP_TOKEN\' }` and set `MCP_TOKEN`, or `token: { file }`.']
    expect(await mcp({ tools: {} }).requires!(ctx)).toEqual(noToken)
    expect(await mcp({ tools: {}, token: { env: 'KAY_TEST_UNSET_MCP_TOKEN' } }).requires!(ctx)).toEqual(noToken)
    expect(await mcp({ tools: {}, token: 'secret-token' }).requires!(ctx)).toEqual([])
    expect(await seo().requires!(ctx)).toEqual(['no `site`, so pages go out with no canonical link, no absolute `og:image` and no sitemap: set `site` in `kay.config.ts` (or pass it to `seo()`).'])
    expect(await seo().requires!({ ...ctx, site: 'https://example.test' })).toEqual([])
    expect(await seo({ site: 'https://example.test' }).requires!(ctx)).toEqual([])
  })

  it('@kayjs/content requires a site for each feed that has none of its own', async () => {
    const posts = defineCollection({ dir: makeTemp('kay-feed-') })
    const feed = { collection: posts, title: 'Posts', description: 'All posts' }
    const plugin = content({ feeds: [feed, { ...feed, path: '/fr/rss.xml' }, { ...feed, path: '/own.xml', site: 'https://own.example' }] })
    expect(await plugin.requires!(ctx)).toEqual([
      'the feed at /rss.xml has no `site`, so its links are relative and feed readers cannot open them: set `site` in `kay.config.ts` (or on the feed).',
      'the feed at /fr/rss.xml has no `site`, so its links are relative and feed readers cannot open them: set `site` in `kay.config.ts` (or on the feed).',
    ])
    expect(await plugin.requires!({ ...ctx, site: 'https://example.test' })).toEqual([])
  })
})
