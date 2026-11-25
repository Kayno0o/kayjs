import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentPlugin, defineCollection, renderMarkdown } from '../../plugin-content/src/index'
import { i18n, localizePath } from '../../plugin-i18n/src/index'
import { createMarkdownImageResolver } from '../../plugin-images/src/plugin'
import { createRooms } from '../../plugin-live/src/index'
import { jsonLd, seo } from '../../plugin-seo/src/index'
import { testApp } from '../src/test/index'

const REPO_ROOT = join(import.meta.dir, '../../..')
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

// Minimal RequestContext helper for unit-testing plugins directly
function makeCtx(urlStr: string, locals: import('../src/server/index').KayLocals = {}, init?: RequestInit) {
  const url = new URL(urlStr)
  const request = new Request(urlStr, init)
  return {
    request,
    url,
    params: {},
    query: url.searchParams,
    locals,
    cookies: { get: () => undefined, set: () => {}, delete: () => {} },
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }),
    text: (body: string, status = 200) => new Response(body, { status }),
    html: (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html' } }),
    redirect: (to: string, status = 302) => Response.redirect(to, status),
  } as unknown as import('../src/server/index').RequestContext
}

describe('Batch 5 Audit — Ecosystem Plugins & Publish Script (#3526)', () => {
  // ── Box 6 + Audit line 21: plugin-seo & plugin-i18n replace patterns + JSON-LD escaping ──
  describe('Box 6 + JSON-LD (@kayjs/seo & @kayjs/i18n)', () => {
    it('keeps $&, $`, $\', $$ verbatim in seo titleTemplate and canonical/description head additions', async () => {
      const plugin = seo({
        site: 'https://example.com',
        titleTemplate: '%s — Kay',
        description: { en: 'Cost is $& or $` or $\' or $$' },
      })
      const ctx = makeCtx('https://example.com/deals/$&/$$/$\'/end', { locale: 'en' })
      const added: string[] = []
      const docHead = {
        lang: 'en',
        htmlAttrs: {} as Record<string, string>,
        title: 'Save $& $` $\' $$ now' as string | undefined,
        get headHtml() {
          return `<title>${this.title ?? ''}</title>${added.join('')}`
        },
        add(html: string) {
          added.push(html)
        },
      }
      await plugin.head!(docHead, ctx)
      const out = docHead.headHtml

      expect(docHead.title).toBe('Save $& $` $\' $$ now — Kay')
      expect(out).toContain('content="Cost is $&amp; or $` or $&#x27; or $$"')
      expect(out).toContain('href="https://example.com/deals/$&amp;/$$/$&#x27;/end"')
    })

    it('escapes every < as \\u003c in JSON-LD so </SCRIPT> and <!--<script> cannot break out', () => {
      const malicious = '</SCRIPT><!--<script>alert(1)</script>'
      const rendered = jsonLd({ '@type': 'Article', 'headline': malicious }).__html
      expect(rendered.startsWith('<script type="application/ld+json">')).toBe(true)
      expect(rendered.endsWith('</script>')).toBe(true)

      const inner = rendered.slice('<script type="application/ld+json">'.length, -'</script>'.length)
      expect(inner).not.toContain('<')
      expect(inner).toContain('\\u003c/SCRIPT>')
      expect(inner).toContain('\\u003c!--\\u003cscript>')
      expect(JSON.parse(inner)).toEqual({
        '@context': 'https://schema.org',
        '@type': 'Article',
        'headline': malicious,
      })
    })

    it('escapes alternate hreflang and href values in i18n head hook (#3559)', async () => {
      const plugin = i18n({
        locales: ['en', 'fr"><script>'],
        defaultLocale: 'en',
        site: 'https://example.com',
      })
      const ctx = makeCtx('https://example.com/price/$&/$\'/$$?a=1', { locale: 'en' })
      const added: string[] = []
      const docHead = {
        lang: 'en',
        htmlAttrs: {} as Record<string, string>,
        title: 'Hi' as string | undefined,
        get headHtml() {
          return added.join('')
        },
        add(html: string) {
          added.push(html)
        },
      }
      await plugin.head!(docHead, ctx)
      const out = added.join('')

      expect(out).toContain('href="https://example.com/price/$&amp;/$&#x27;/$$"')
      expect(out).toContain('hreflang="fr&quot;&gt;&lt;script&gt;"')
      expect(out).not.toContain('<script>')
    })
  })

  // ── Box 14: Markdown component props parsed as literals ONLY (zero new Function) ──
  describe('Box 14 (@kayjs/content literal-only component props)', () => {
    it('contains zero new Function or eval calls in plugin-content', () => {
      const src = readFileSync(join(REPO_ROOT, 'packages/plugin-content/src/index.ts'), 'utf8')
      expect(src).not.toMatch(/\bnew\s+Function\b/)
      expect(src).not.toMatch(/\beval\s*\(/)
    })

    it('parses JSON5-style literal props without executing arbitrary JS expressions', () => {
      const g = globalThis as Record<string, unknown>
      delete g.__box14Executed

      let received: Record<string, unknown> | undefined
      const md = `
<Widget
  title="Stats"
  single='hello'
  flag
  count={-42.5}
  active={true}
  empty={null}
  config={{
    label: 'Kay v2',
    nested: [1, 'two', false, { a: 1, },],
  }}
  evil={(() => { globalThis.__box14Executed = true; return 'pwned' })()}
  expr={1 + 2}
/>
`
      renderMarkdown(md, {
        components: {
          Widget: (props: Record<string, unknown>) => {
            received = props
            return '<div>ok</div>'
          },
        },
      })

      expect(g.__box14Executed).toBeUndefined()
      expect(received).toBeDefined()
      expect(received!.title).toBe('Stats')
      expect(received!.single).toBe('hello')
      expect(received!.flag).toBe(true)
      expect(received!.count).toBe(-42.5)
      expect(received!.active).toBe(true)
      expect(received!.empty).toBeNull()
      expect(received!.config).toEqual({
        label: 'Kay v2',
        nested: [1, 'two', false, { a: 1 }],
      })
      expect(received!.evil).toBeUndefined()
      expect(received!.expr).toBeUndefined()
    })
  })

  // ── Box 15: Markdown HTML sanitized by default unless trusted: true ──
  describe('Box 15 (@kayjs/content Markdown HTML sanitization)', () => {
    it('sanitizes dangerous tags, event handlers, srcdoc, and dangerous URL schemes by default', () => {
      const md = `
# Hello

Safe **bold** and [good link](https://example.com) and ![ok](/img/a.png).

- [x] Done task

<script>alert('xss')</script>
<iframe src="https://evil.test" srcdoc="<script>alert(1)</script>">fallback</iframe>
<object data="evil.swf">obj</object>
<embed src="evil.swf">
<style>body { display: none }</style>
<form action="https://evil.test"><button formaction="javascript:alert(1)">Go</button></form>
<base href="https://evil.test/">
<meta http-equiv="refresh" content="0;url=https://evil.test">
<link rel="stylesheet" href="https://evil.test/x.css">
<img src="x" onerror="alert(1)" alt="pic">
<a href="javascript:alert(1)" onclick="alert(2)">bad js</a>
<a href="vbscript:msgbox(1)">bad vbs</a>
<a href="data:text/html,<script>alert(1)</script>">bad data</a>
<details open><summary>More</summary><p>Details text</p></details>
<Badge label="trusted-component" />
`
      const rendered = renderMarkdown(md, {
        highlight: (code, lang) => `<pre class="shiki" data-lang="${lang ?? ''}"><code><span style="color:#fff">${code}</span></code></pre>`,
        components: {
          Badge: ({ label }: { label: string }) => `<span class="badge" data-badge="${label}">${label}</span>`,
        },
      })

      const html = rendered.html
      // Dangerous constructs stripped
      expect(html).not.toMatch(/<script\b/i)
      expect(html).not.toContain('alert(\'xss\')')
      expect(html).not.toMatch(/<iframe\b/i)
      expect(html).not.toMatch(/<object\b/i)
      expect(html).not.toMatch(/<embed\b/i)
      expect(html).not.toMatch(/<style\b/i)
      expect(html).not.toContain('display: none')
      expect(html).not.toMatch(/<form\b/i)
      expect(html).not.toMatch(/<base\b/i)
      expect(html).not.toMatch(/<meta\b/i)
      expect(html).not.toMatch(/<link\b/i)
      expect(html).not.toMatch(/\bonerror\s*=/i)
      expect(html).not.toMatch(/\bonclick\s*=/i)
      expect(html).not.toMatch(/\bsrcdoc\s*=/i)
      expect(html).not.toMatch(/javascript:/i)
      expect(html).not.toMatch(/vbscript:/i)
      expect(html).not.toMatch(/data:text\/html/i)

      // Safe Markdown & custom component output preserved
      expect(html).toContain('<h1 id="hello">Hello</h1>')
      expect(html).toContain('<strong>bold</strong>')
      expect(html).toContain('href="https://example.com"')
      expect(html).toContain('<input type="checkbox"')
      expect(html).toContain('<details open')
      expect(html).toContain('<summary>More</summary>')
      expect(html).toContain('<span class="badge" data-badge="trusted-component">trusted-component</span>')
    })

    it('allows opting out of sanitization with trusted: true on renderMarkdown and defineCollection', () => {
      const md = `<iframe src="https://example.com/embed"></iframe>`
      expect(renderMarkdown(md).html).not.toContain('<iframe')
      expect(renderMarkdown(md, { trusted: true }).html).toContain('<iframe src="https://example.com/embed"></iframe>')

      const dir = makeTemp('kay-trusted-col-')
      writeFileSync(join(dir, 'post.md'), `---\ntitle: Trusted\n---\n${md}\n`)
      const untrustedCol = defineCollection({ dir })
      const trustedCol = defineCollection({ dir, trusted: true })
      expect(untrustedCol.get('post')!.html).not.toContain('<iframe')
      expect(trustedCol.get('post')!.html).toContain('<iframe src="https://example.com/embed"></iframe>')
    })
  })

  // ── Box 42: Content collection file-list caching & memoised RSS feed with ETag ──
  describe('Box 42 (@kayjs/content file-list cache & memoised RSS with ETag)', () => {
    it('caches directory walk in production, invalidates on clearCache(), and refreshes in dev (KAY_DEV=1)', () => {
      const dir = makeTemp('kay-content-cache-')
      writeFileSync(join(dir, 'a.md'), '---\ntitle: A\ndate: 2026-01-01\n---\nHello A\n')

      const prevDev = process.env.KAY_DEV
      delete process.env.KAY_DEV
      try {
        const col = defineCollection({ dir })
        expect(col.all().map(e => e.slug)).toEqual(['a'])

        // Add a new file on disk: cached production collection should NOT re-walk yet
        writeFileSync(join(dir, 'b.md'), '---\ntitle: B\ndate: 2026-01-02\n---\nHello B\n')
        expect(col.all().map(e => e.slug)).toEqual(['a'])

        // Clearing cache invalidates the file list and picks up b.md
        col.clearCache()
        expect(col.all().map(e => e.slug)).toEqual(['b', 'a'])

        // In dev mode (KAY_DEV=1), edits/new files appear immediately without clearCache()
        process.env.KAY_DEV = '1'
        writeFileSync(join(dir, 'c.md'), '---\ntitle: C\ndate: 2026-01-03\n---\nHello C\n')
        expect(col.all().map(e => e.slug)).toEqual(['c', 'b', 'a'])
      }
      finally {
        if (prevDev === undefined)
          delete process.env.KAY_DEV
        else
          process.env.KAY_DEV = prevDev
      }
    })

    it('memoises RSS response and returns ETag + 304 Not Modified on matching If-None-Match', async () => {
      const dir = makeTemp('kay-rss-etag-')
      const postsDir = join(dir, 'content')
      mkdirSync(postsDir, { recursive: true })
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Hi</h1> }')
      writeFileSync(join(postsDir, 'hello.md'), '---\ntitle: Hello RSS\ndate: 2026-01-01\n---\nBody\n')

      let mapItemCalls = 0
      const col = defineCollection({ dir: postsDir })
      const plugin = contentPlugin({
        feeds: [{
          path: '/rss.xml',
          title: 'Test Feed',
          description: 'Desc',
          site: 'https://example.com',
          collection: col,
          mapItem: (e) => {
            mapItemCalls++
            return { title: String(e.data.title ?? '') }
          },
        }],
      })

      const prevDev = process.env.KAY_DEV
      delete process.env.KAY_DEV
      try {
        const app = await testApp({ root: dir, plugins: [plugin] })
        const res1 = await app.get('/rss.xml')
        expect(res1.status).toBe(200)
        const etag = res1.headers.get('etag')
        expect(etag).toBeTruthy()
        expect(await res1.text()).toContain('<title>Hello RSS</title>')
        const callsAfterFirst = mapItemCalls

        // Second request uses memoised RSS (does not recompute mapItem)
        const res2 = await app.get('/rss.xml')
        expect(res2.status).toBe(200)
        expect(res2.headers.get('etag')).toBe(etag)
        expect(mapItemCalls).toBe(callsAfterFirst)

        // Matching If-None-Match returns 304 Not Modified
        const res304 = await app.get('/rss.xml', { 'if-none-match': etag! })
        expect(res304.status).toBe(304)
        expect(await res304.text()).toBe('')

        // Weak ETag form also returns 304 Not Modified
        const res304Weak = await app.get('/rss.xml', { 'if-none-match': `W/${etag!}` })
        expect(res304Weak.status).toBe(304)

        // Clearing collection cache invalidates memoized RSS end-to-end through testApp (plugin route takes precedence over static public/rss.xml)
        writeFileSync(join(postsDir, 'second.md'), '---\ntitle: Second RSS\ndate: 2026-01-02\n---\nBody 2\n')
        col.clearCache()
        const res3 = await app.get('/rss.xml')
        expect(res3.status).toBe(200)
        expect(await res3.text()).toContain('<title>Second RSS</title>')
        expect(res3.headers.get('etag')).not.toBe(etag)
      }
      finally {
        if (prevDev === undefined)
          delete process.env.KAY_DEV
        else
          process.env.KAY_DEV = prevDev
      }
    })
  })

  // ── Box 16: plugin-images refuses ../../.env, non-image extensions, and escapes ──
  describe('Box 16 (@kayjs/images Markdown resolver confinement & extensions)', () => {
    it('refuses path traversal, symlinks outside root, and non-image extensions while resolving valid project images', () => {
      const outer = makeTemp('kay-img-audit-')
      const projectRoot = join(outer, 'project')
      const postDir = join(projectRoot, 'src/content/posts')
      const imgDir = join(postDir, 'img')
      const outPublicDir = join(projectRoot, 'dist/public')
      const cacheDir = join(projectRoot, '.kay-cache/images')
      mkdirSync(imgDir, { recursive: true })

      // Valid 1x1 PNG
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      )
      writeFileSync(join(outer, '.env'), 'SECRET_KEY=super-secret')
      writeFileSync(join(outer, 'outside.png'), pngBytes)
      writeFileSync(join(projectRoot, '.env'), 'PROJECT_SECRET=nope')
      writeFileSync(join(postDir, 'notes.ts'), 'export const x = 1')
      writeFileSync(join(imgDir, 'ok.png'), pngBytes)
      symlinkSync(join(outer, 'outside.png'), join(imgDir, 'escape-link.png'))
      symlinkSync(join(projectRoot, '.env'), join(imgDir, 'env-link.png'))

      const mdFile = join(postDir, 'hello.md')
      const resolver = createMarkdownImageResolver({
        root: projectRoot,
        outPublicDir,
        cacheDir,
        widths: [320],
        formats: ['webp'],
      })

      // Traversal outside root (.env and .png)
      expect(resolver('../../../../.env', mdFile)).toBeUndefined()
      expect(resolver('../../../../outside.png', mdFile)).toBeUndefined()
      // Non-image files inside root
      expect(resolver('../../../.env', mdFile)).toBeUndefined()
      expect(resolver('./notes.ts', mdFile)).toBeUndefined()
      // Symlinks pointing outside root or to non-image file
      expect(resolver('./img/escape-link.png', mdFile)).toBeUndefined()
      expect(resolver('./img/env-link.png', mdFile)).toBeUndefined()

      // Nothing leaked into dist/public/img yet
      expect(existsSync(join(outPublicDir, 'img'))).toBe(false)

      // Valid image inside project root succeeds
      const ok = resolver('./img/ok.png', mdFile)
      expect(ok).toBeDefined()
      expect(ok!.src).toMatch(/^\/img\/ok-/)
    })
  })

  // ── Box 17: plugin-i18n localizePath & //cdn protocol-relative links ──
  describe('Box 17 (@kayjs/i18n open-redirect & protocol-relative hrefs)', () => {
    it('collapses leading slashes in localizePath so /fr//evil.com never yields //evil.com', () => {
      expect(localizePath('/fr//evil.com', 'en', 'en', ['en', 'fr'])).toBe('/evil.com')
      expect(localizePath('///evil.com', 'en', 'en', ['en', 'fr'])).toBe('/evil.com')
      expect(localizePath('/fr//evil.com', 'fr', 'en', ['en', 'fr'])).toBe('/fr/evil.com')
    })

    it('leaves protocol-relative //cdn hrefs untouched in transformHtml', () => {
      const plugin = i18n({ locales: ['en', 'fr'], defaultLocale: 'en' })
      const ctx = makeCtx('https://example.com/fr/page', { locale: 'fr' })
      const html = '<html lang="en"><body><a href="//cdn.ex.org/x">CDN</a><a href="/about">About</a></body></html>'
      const out = plugin.transformHtml!(html, ctx)

      expect(out).toContain('<a href="//cdn.ex.org/x">CDN</a>')
      expect(out).toContain('<a href="/fr/about">About</a>')
    })
  })

  // ── Box 18: plugin-live server caps, stalled drop, CR/LF refusal, authorize ──
  describe('Box 18 (@kayjs/live server hardening)', () => {
    it('refuses CR or LF in SSE event names to prevent frame injection', () => {
      const rooms = createRooms<{ msg: string }, string>()
      expect(() => rooms.publish('r1', { msg: 'hi' }, 'update\ndata: injected')).toThrow()
      expect(() => rooms.publish('r1', { msg: 'hi' }, 'update\r\nevent: evil')).toThrow()
    })

    it('tracks total connections accurately with maxTotalConnections across rooms, joins, and disconnects (#3563)', () => {
      const rooms = createRooms<{ n: number }, string>({
        maxConnectionsPerRoom: 5,
        maxConnectionsPerClient: 5,
        maxTotalConnections: 2,
      })
      const ac1 = new AbortController()
      const ac2 = new AbortController()
      const ac3 = new AbortController()
      const fromIp = (ip: string, signal: AbortSignal) => Object.assign(makeCtx('http://localhost/live', {}, { signal }), { ip })

      const r1 = rooms.stream(fromIp('1.1.1.1', ac1.signal), { room: 'a', member: 'u1', pingMs: 0 })
      const r2 = rooms.stream(fromIp('2.2.2.2', ac2.signal), { room: 'b', member: 'u2', pingMs: 0 })
      const r3 = rooms.stream(fromIp('3.3.3.3', ac3.signal), { room: 'c', member: 'u3', pingMs: 0 })
      expect(r1.status).toBe(200)
      expect(r2.status).toBe(200)
      expect(r3.status).toBe(503)

      // Disconnecting one client frees a slot immediately
      ac1.abort()
      const ac4 = new AbortController()
      const r4 = rooms.stream(fromIp('4.4.4.4', ac4.signal), { room: 'c', member: 'u4', pingMs: 0 })
      expect(r4.status).toBe(200)
      ac2.abort()
      ac4.abort()
    })

    it('enforces per-room and per-client connection caps with 503/429', () => {
      const rooms = createRooms<{ n: number }, string>({
        maxConnectionsPerRoom: 2,
        maxConnectionsPerClient: 1,
      })

      const ac1 = new AbortController()
      const ac2 = new AbortController()
      const ac3 = new AbortController()

      const fromIp = (ip: string | undefined, init?: RequestInit) => Object.assign(makeCtx('http://localhost/live', {}, init), { ip })
      const r1 = rooms.stream(fromIp('1.1.1.1', { signal: ac1.signal }), { room: 'a', member: 'u1', pingMs: 0 })
      expect(r1.status).toBe(200)

      // Same client exceeds maxConnectionsPerClient -> 429
      const rSameClient = rooms.stream(fromIp('1.1.1.1', { headers: { 'x-forwarded-for': '7.7.7.7' } }), { room: 'a', member: 'u1b', pingMs: 0 })
      expect(rSameClient.status).toBe(429)

      // Second client joins room 'a' -> succeeds (2/2)
      const r2 = rooms.stream(fromIp('2.2.2.2', { signal: ac2.signal }), { room: 'a', member: 'u2', pingMs: 0 })
      expect(r2.status).toBe(200)

      // Third client exceeds maxConnectionsPerRoom -> 503
      const r3 = rooms.stream(fromIp('3.3.3.3', { signal: ac3.signal }), { room: 'a', member: 'u3', pingMs: 0 })
      expect(r3.status).toBe(503)

      // Disconnecting frees capacity
      ac1.abort()
      const r4 = rooms.stream(fromIp('1.1.1.1'), { room: 'a', member: 'u1-rejoin', pingMs: 0 })
      expect(r4.status).toBe(200)
      ac2.abort()

      // Without ctx.ip, a client-sent X-Forwarded-For does not buy a fresh per-client quota
      const lone = createRooms<{ n: number }, string>({ maxConnectionsPerClient: 1 })
      const acA = new AbortController()
      expect(lone.stream(fromIp(undefined, { headers: { 'x-forwarded-for': '4.4.4.4' }, signal: acA.signal }), { room: 'b', member: 'x', pingMs: 0 }).status).toBe(200)
      expect(lone.stream(fromIp(undefined, { headers: { 'x-forwarded-for': '5.5.5.5' } }), { room: 'b', member: 'y', pingMs: 0 }).status).toBe(429)
      acA.abort()
    })

    it('drops stalled subscribers when controller.desiredSize <= 0', () => {
      const rooms = createRooms<{ seq: number }, string>()
      let left = false
      const res = rooms.stream(makeCtx('http://localhost/live'), {
        room: 'stall',
        member: 'slow',
        pingMs: 0,
        highWaterMark: 3,
        onLeave: () => {
          left = true
        },
      })
      expect(res.status).toBe(200)
      expect(rooms.size('stall')).toBe(1)

      // Nobody reads res.body -> queue fills up and subscriber is dropped
      for (let i = 0; i < 10; i++)
        rooms.publish('stall', { seq: i })

      expect(rooms.size('stall')).toBe(0)
      expect(left).toBe(true)
    })

    it('supports authorize hook on rooms.plugin() returning false (403), custom Response, or true (200)', async () => {
      const dir = makeTemp('kay-live-auth-')
      mkdirSync(join(dir, 'src/routes'), { recursive: true })
      writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Live</h1> }')

      const rooms = createRooms<{ text: string }, string>()
      const plugin = rooms.plugin({
        path: '/api/live',
        room: ctx => ctx.url.searchParams.get('room') ?? 'default',
        member: () => 'guest',
        pingMs: 0,
        authorize: (ctx, room) => {
          const token = ctx.request.headers.get('authorization')
          if (room === 'secret' && !token)
            return false
          if (token === 'expired')
            return new Response('Token expired', { status: 401 })
          return true
        },
      })

      const app = await testApp({ root: dir, plugins: [plugin] })

      const denied = await app.get('/api/live?room=secret')
      expect(denied.status).toBe(403)

      const custom = await app.get('/api/live?room=secret', {
        authorization: 'expired',
      })
      expect(custom.status).toBe(401)
      expect(await custom.text()).toBe('Token expired')

      const ac = new AbortController()
      const ok = await app.app.handle(new Request('http://localhost/api/live?room=secret', {
        headers: { authorization: 'valid' },
        signal: ac.signal,
      }))
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toContain('text/event-stream')
      ac.abort()
    })
  })

  // ── Box 39: plugin-live client reconnects closed EventSource with backoff & jitter ──
  describe('Box 39 (@kayjs/live client EventSource reconnect)', () => {
    it('recreates closed EventSource with exponential backoff + jitter and cleans up on close()', async () => {
      const origEventSource = globalThis.EventSource
      const instances: MockES[] = []

      class MockES {
        static readonly CONNECTING = 0
        static readonly OPEN = 1
        static readonly CLOSED = 2
        readonly CONNECTING = 0
        readonly OPEN = 1
        readonly CLOSED = 2
        readyState = 0
        url: string
        onopen: (() => void) | null = null
        onerror: (() => void) | null = null
        onmessage: ((ev: { data: string }) => void) | null = null
        closed = false
        constructor(url: string) {
          this.url = url
          instances.push(this)
        }

        close() {
          this.closed = true
          this.readyState = MockES.CLOSED
        }
      }

      globalThis.EventSource = MockES as unknown as typeof EventSource
      try {
        // Test mounting via mount() / onMount() lifecycle
        GlobalRegistrator.register({ url: 'http://localhost/' })
        try {
          const { root: createRoot } = await import('../src/reactivity/index')
          const { useLive } = await import('../../plugin-live/src/client')
          const received: Array<{ v: number }> = []
          let conn!: ReturnType<typeof useLive<{ v: number }>>
          let dispose!: () => void

          createRoot((d) => {
            dispose = d
            conn = useLive<{ v: number }>('/api/stream', m => received.push(m), {
              baseDelayMs: 15,
              maxDelayMs: 80,
              jitterMs: 5,
            })
          })
          await Promise.resolve()

          expect(instances.length).toBe(1)
          const es1 = instances[0]!
          es1.readyState = MockES.OPEN
          es1.onopen?.()
          expect(conn.status.value).toBe('open')

          // Simulate fatal 502/restart closing EventSource
          es1.readyState = MockES.CLOSED
          es1.onerror?.()
          expect(conn.status.value).toBe('closed')

          // Wait for backoff + jitter -> new EventSource created!
          await Bun.sleep(45)
          expect(instances.length).toBe(2)
          const es2 = instances[1]!
          es2.readyState = MockES.OPEN
          es2.onopen?.()
          expect(conn.status.value).toBe('open')
          es2.onmessage?.({ data: JSON.stringify({ v: 42 }) })
          expect(received).toEqual([{ v: 42 }])

          // Trigger another close and immediately dispose before timer fires -> no 3rd instance!
          es2.readyState = MockES.CLOSED
          es2.onerror?.()
          dispose()
          await Bun.sleep(45)
          expect(instances.length).toBe(2)
        }
        finally {
          await GlobalRegistrator.unregister()
        }
      }
      finally {
        globalThis.EventSource = origEventSource
      }
    })
  })

  // ── Box 23 & Box 38: plugin-spa client focus, live region, opt-in prefetch, error recovery, #100%, popstate ──
  describe('Box 23 & Box 38 (@kayjs/spa client a11y & resilience)', () => {
    it('moves focus to main/h1, announces title in polite live region, opts-in prefetch, recovers fetch failure, handles #100%, and skips same-doc popstate', async () => {
      GlobalRegistrator.register({ url: 'http://localhost/', settings: { handleDisabledFileLoadingAsSuccess: true } })
      const origFetch = globalThis.fetch
      const fetchedUrls: string[] = []
      const assignedUrls: string[] = []
      try {
        // Spy on location.assign
        const origAssign = window.location.assign.bind(window.location)
        Object.defineProperty(window.location, 'assign', {
          configurable: true,
          value: (u: string) => {
            assignedUrls.push(u)
          },
        })

        document.head.innerHTML = '<title>Home</title>'
        document.body.innerHTML = [
          '<nav>',
          '<a id="logout" href="/logout">Logout</a>',
          '<a id="optin" href="/about" data-kay-prefetch>About</a>',
          '<a id="broken" href="/offline">Offline</a>',
          '</nav>',
          '<main><h1>Home</h1></main>',
        ].join('')

        const pages: Record<string, string> = {
          'http://localhost/about': '<!DOCTYPE html><html><head><title>About Us</title></head><body><main><h1>About Heading</h1><p id="100%">Percent</p></main></body></html>',
          'http://localhost/no-main': '<!DOCTYPE html><html><head><title>Only Heading</title></head><body><h1>Standalone H1</h1></body></html>',
        }

        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
          fetchedUrls.push(url)
          if (url === 'http://localhost/offline')
            throw new TypeError('Network failure')
          const html = pages[url] ?? '<html><head><title>404</title></head><body>404</body></html>'
          const res = new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
          Object.defineProperty(res, 'url', { value: url })
          return res
        }) as typeof fetch

        const spa = await import(`../../plugin-spa/src/client.ts?audit=${Date.now()}`)

        // 1. Box 38: Hovering/focusing a normal link (/logout) MUST NOT prefetch!
        const logoutLink = document.getElementById('logout')!
        logoutLink.dispatchEvent(new Event('pointerover', { bubbles: true }))
        logoutLink.dispatchEvent(new Event('focusin', { bubbles: true }))
        await Bun.sleep(10)
        expect(fetchedUrls).not.toContain('http://localhost/logout')

        // Hovering a link WITH data-kay-prefetch DOES prefetch
        const optInLink = document.getElementById('optin')!
        optInLink.dispatchEvent(new Event('pointerover', { bubbles: true }))
        await Bun.sleep(10)
        expect(fetchedUrls).toContain('http://localhost/about')

        // 2. Box 23 + Box 38 (#100%): Navigate to /about#100% -> does not throw, focuses main, announces title!
        await spa.navigate('http://localhost/about#100%', true)
        expect(document.title).toBe('About Us')
        const main = document.querySelector('main')!
        expect(main.getAttribute('tabindex')).toBe('-1')
        expect(document.activeElement).toBe(main)
        const liveRegion = document.querySelector('[aria-live="polite"]')
        expect(liveRegion).not.toBeNull()
        expect(liveRegion!.textContent).toBe('About Us')

        // 3. Box 38: Same-document popstate (hash-only change on /about) MUST NOT refetch or replace body!
        const countBeforePop = fetchedUrls.length
        const bodyBeforePop = document.body
        history.pushState(null, '', '/about#section2')
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
        await Bun.sleep(15)
        expect(fetchedUrls.length).toBe(countBeforePop)
        expect(document.body).toBe(bodyBeforePop)

        // 4. Box 23: Page without <main> focuses <h1> and announces title
        await spa.navigate('http://localhost/no-main', true)
        const h1 = document.querySelector('h1')!
        expect(h1.getAttribute('tabindex')).toBe('-1')
        expect(document.activeElement).toBe(h1)
        expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('Only Heading')

        // 5. Box 38: Fetch failure recovers via window.location.assign(url)
        await spa.navigate('http://localhost/offline', true)
        expect(assignedUrls).toContain('http://localhost/offline')

        Object.defineProperty(window.location, 'assign', { configurable: true, value: origAssign })
      }
      finally {
        globalThis.fetch = origFetch
        await GlobalRegistrator.unregister()
      }
    })
  })

  // ── Box 43: scripts/publish-packages.sh fails when npm stage publish fails ──
  describe('Box 43 (scripts/publish-packages.sh error propagation)', () => {
    it('exits non-zero when npm stage publish fails and exits zero when it succeeds', () => {
      const workDir = makeTemp('kay-publish-sh-')
      const mockBin = join(workDir, 'bin')
      const pkgDir = join(workDir, 'packages/sample')
      mkdirSync(mockBin, { recursive: true })
      mkdirSync(pkgDir, { recursive: true })

      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@kayjs/sample',
        version: '2.0.0-alpha.99',
        private: false,
      }))

      // Mock bun: `bun pm view` returns 1 (not yet published), `bun pm pack` creates tarball
      const mockBun = join(mockBin, 'bun')
      writeFileSync(mockBun, `#!/bin/sh
if [ "$1" = "pm" ] && [ "$2" = "view" ]; then
  exit 1
fi
if [ "$1" = "pm" ] && [ "$2" = "pack" ]; then
  while [ $# -gt 0 ]; do
    if [ "$1" = "--filename" ]; then
      touch "$2"
      exit 0
    fi
    shift
  done
  exit 0
fi
exit 0
`)
      chmodSync(mockBun, 0o755)

      // Mock npm that FAILS `npm stage publish`
      const mockNpm = join(mockBin, 'npm')
      writeFileSync(mockNpm, `#!/bin/sh
echo "simulated stage failure" >&2
exit 1
`)
      chmodSync(mockNpm, 0o755)

      const scriptPath = join(REPO_ROOT, 'scripts/publish-packages.sh')
      const failProc = Bun.spawnSync(['sh', scriptPath, '--stage', 'https://registry.npmjs.org'], {
        cwd: workDir,
        env: { ...process.env, PATH: `${mockBin}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(failProc.exitCode).not.toBe(0)

      // Now mock npm SUCCEEDS
      writeFileSync(mockNpm, `#!/bin/sh
exit 0
`)
      chmodSync(mockNpm, 0o755)

      const okProc = Bun.spawnSync(['sh', scriptPath, '--stage', 'https://registry.npmjs.org'], {
        cwd: workDir,
        env: { ...process.env, PATH: `${mockBin}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(okProc.exitCode).toBe(0)
    })
  })
})
