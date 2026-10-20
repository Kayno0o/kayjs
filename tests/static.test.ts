import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { headersFile, nginxHeaders } from '../src/build/header-files'
import { IMAGE_LINK } from '../src/server/prerender'
import { expectEagerJsWithin, lazyChunks } from './eager-js'
import { fixtureCopy } from './scratch'

const FIXTURE = resolve('tests/fixtures/static')
const CLI = resolve('src/cli.ts')
const BASE = '/repo'
// The gzipped JS a page with one small island loads before anything is clicked, a few bytes above what it measures: a change growing it pays for its bytes with a cut elsewhere in the eager runtime, or, when none is clean and it buys speed or reliability in the browser, raises this.
// The runtime is split by who imports each name, which costs the import statements between its chunks, about 12 bytes here.
// Keeping a pending block shown while a reload or another document replaces the page costs 19 bytes here, raised for it as it keeps a slow submit from looking dead.
const EAGER_JS_BUDGET = 8_702
const LAZY_CHUNKS = ['fetch-island', 'forms', 'hydrate-when', 'live-cache', 'live-props', 'page-swap', 'prefetch', 'static-slots']
const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g

let out: string
let server: ReturnType<typeof Bun.serve>
// The host a page links an image of, which the export downloads.
const remoteHost = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(join(FIXTURE, 'src/hero.png'))) })

// Under NODE_ENV=development too, as a shell left set for `kay dev` runs it, the build exports production pages.
async function exportSite(outdir: string, root = FIXTURE): Promise<{ code: number, errors: string }> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development', KAY_TEST_REMOTE_ORIGIN: `http://127.0.0.1:${remoteHost.port}` } })
  const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

  return { code, errors }
}

// A plain file server, as a static host is: the site under its mount point, `about` found as `about.html` or `about/index.html`, and `404.html` for the rest.
function serveDirectory(dir: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)

      if (pathname !== BASE && !pathname.startsWith(`${BASE}/`))
        return new Response('Not under the mount point', { status: 404 })

      const path = decodeURIComponent(pathname.slice(BASE.length)) || '/'

      for (const candidate of [path, `${path}.html`, join(path, 'index.html')]) {
        const file = Bun.file(join(dir, candidate))

        if (!candidate.endsWith('/') && await file.exists())
          return new Response(file)
      }

      return new Response(Bun.file(join(dir, '404.html')), { status: 404 })
    },
  })
}

async function get(path: string): Promise<{ status: number, text: string }> {
  const response = await fetch(new URL(`${BASE}${path}`, server.url))

  return { status: response.status, text: await response.text() }
}

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'kay-static-'))
  // The chunks of the shared fixture's earlier builds, the one in place and those kept, would join the export as a deploy keeps them for open tabs: this one carries its own alone.
  await Promise.all((await Array.fromAsync(new Bun.Glob('.kay/client*').scan({ cwd: FIXTURE, dot: true, onlyFiles: false }))).map(async dir => rm(join(FIXTURE, dir), { recursive: true, force: true })))

  const { code, errors } = await exportSite(out)

  if (code !== 0)
    throw new Error(errors)

  server = serveDirectory(out)
})

afterAll(async () => {
  await server.stop(true)
  await remoteHost.stop(true)
  await rm(out, { recursive: true, force: true })
})

const INLINE_ELEMENT = /<(script|style)(?:\s[^>]*)?>([^<]+)<\/\1>/g

// The inline scripts and styles of every page of an export that its `_headers` policy lets through neither by their hash nor by `'unsafe-inline'`, which a browser ignores beside a hash, and the number of inline elements it checked.
async function uncoveredInline(dir: string): Promise<{ uncovered: string[], checked: number }> {
  const policy = (await Bun.file(join(dir, '_headers')).text()).match(/Content-Security-Policy: (.+)/)![1]!
  const directives = new Map(policy.split(';').map(part => part.trim().split(' ')).map(([name, ...sources]) => [name!, sources]))
  const uncovered: string[] = []
  let checked = 0

  for (const page of await Array.fromAsync(new Bun.Glob('**/*.html').scan({ cwd: dir }))) {
    for (const [, tag, body] of (await Bun.file(join(dir, page)).text()).matchAll(INLINE_ELEMENT)) {
      const hash = `'sha256-${new Bun.CryptoHasher('sha256').update(body!).digest('base64')}'`
      const sources = directives.get(tag === 'script' ? 'script-src' : 'style-src') ?? directives.get('default-src')!

      checked++

      if (!sources.includes(hash) && !(sources.includes('\'unsafe-inline\'') && !sources.some(source => source.startsWith('\'sha256-'))))
        uncovered.push(`${page}: ${tag} ${hash} is in none of ${sources.join(' ')}`)
    }
  }

  return { uncovered, checked }
}

describe('kay build --static', () => {
  it('writes every page, linked under the mount point, as a plain file server finds it', async () => {
    const home = await get('/')

    expect(home.status).toBe(200)
    expect(home.text).toContain('<a class="home" href="/repo/" aria-current="page">Home</a><a class="about" href="/repo/about">About</a>')
    expect((await get('/about')).text).toContain('<h1>About</h1><p class="share">https://x.example/repo/about</p>')
    expect((await get('/about/')).text).toContain('<h1>About</h1>')
    expect((await get('/posts/first')).text).toContain('<h1>Post first</h1>')
  })

  it('refuses a page linking the image route, which a static host lacks, in an attribute only', () => {
    expect(IMAGE_LINK.test('<img src="/_kay/image?src=%2Fuploads%2Fa.png&amp;w=640">')).toBe(true)
    expect(IMAGE_LINK.test('<img srcset="/a.webp 320w, /_kay/image?src=b&amp;w=640 640w">')).toBe(true)
    expect(IMAGE_LINK.test('<p>Variants are served by <code>/_kay/image?src=...&amp;w=...</code></p>')).toBe(false)
    expect(IMAGE_LINK.test(`<slot data-component="lightbox.kay" data-props='[{"src":1},"/_kay/image?src=a.png&amp;w=100"]'></slot>`)).toBe(true)
  })

  it('caps image densities at the config\'s images.maxDensity, for the islands too', async () => {
    const home = (await get('/')).text

    expect(home).toContain('<meta name="kay-max-density" content="3">')
    expect(home).toContain('(min-resolution: 4dppx) calc(100vw * 3 / 4)')
  })

  it('serves the islands, stylesheets and image variants from their files, compressed copies beside them', async () => {
    const home = (await get('/')).text
    const entry = (/<script type="module" src="\/repo(\/_kay\/entry-[\w-]+\.js)">/).exec(home)![1]!
    const stylesheet = (/<link rel="stylesheet" href="\/repo(\/_kay\/[\w-]+\.css)">/).exec(home)![1]!
    const image = (/<img[^>]*? src="\/repo(\/_kay\/images\/[\w-]+\.webp)"/).exec(home)![1]!

    const script = await get(entry)

    expect(script.status).toBe(200)
    expect(script.text).toContain('"/repo/_kay/env.js"')
    expect(home).toContain('<link rel="modulepreload" href="/repo/_kay/env.js">')
    expect((await get('/_kay/env.js')).text).toBe('export default {"KAY_TEST_STATIC_KEY":"static-key"}\n')
    expect((await get(stylesheet)).text).toContain('url(/repo/humans.txt)')
    expect((await get(image)).status).toBe(200)

    // The cut variants and the share card the page asks for are written too.
    const square = (/<img[^>]*? src="\/repo(\/_kay\/images\/[\w-]+-1x1\.webp)"/).exec(home)![1]!
    const card = (/<meta property="og:image" content="https:\/\/x\.example\/repo(\/_kay\/images\/[\w-]+-card\.jpg)">/).exec(home)![1]!

    expect((await get(square)).status).toBe(200)

    // A remote image's variants are downloaded and written as files, named after its URL.
    const remote = (/<img[^>]*? src="\/repo(\/_kay\/images\/remote-\w+-1000\.webp)" srcset="([^"]+)"/).exec(home)!
    const variant = await fetch(new URL(`${BASE}${remote[1]}`, server.url))

    expect(remote[2]).toContain('-320.webp 320w')
    expect(await new Bun.Image(await variant.bytes()).metadata()).toEqual({ width: 1000, height: 600, format: 'webp' })
    expect((await get(card)).status).toBe(200)
    expect(home).toContain('<slot data-component="src/components/counter.kay"')
    expect(await Bun.file(join(out, '_kay', `${entry.slice('/_kay/'.length)}.br`)).exists()).toBe(true)
    expect(await Bun.file(join(out, 'index.html.gz')).exists()).toBe(true)
  })

  it('hands each page to the page hook of an extension once the files it links are written, before compressing it', async () => {
    const home = (await get('/')).text
    const linked = (/<!--linked from \/: ([^>]*)-->/).exec(home)![1]!.split(' ')
    const named = (pattern: RegExp) => pattern.exec(home)![1]!

    expect(linked).toContain(named(/<link rel="stylesheet" href="\/repo\/_kay\/([\w-]+\.css)">/))
    expect(linked).toContain(named(/<script type="module" src="\/repo\/_kay\/(entry-[\w-]+\.js)">/))
    expect(linked).toContain(named(/<img[^>]*? src="\/repo\/_kay\/images\/([\w-]+-1x1\.webp)"/))
    expect(linked).toContain('favicon.svg')
    expect(new TextDecoder().decode(Bun.gunzipSync(await Bun.file(join(out, 'index.html.gz')).bytes()))).toContain('<!--linked from /: ')
    expect((await get('/about')).text).toContain('<!--linked from /about: ')
  })

  it('ships none of the persisted signal or query param code to an island calling signal() alone', async () => {
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const code = await Promise.all(chunks.map(async chunk => Bun.file(join(out, chunk)).text()))

    // The counter's own chunk is among them, so its imports are too.
    expect(code.some(text => text.includes('<button>Count'))).toBe(true)
    expect(code.filter(text => text.includes('cannot name a cookie'))).toEqual([])
    expect(code.filter(text => text.includes('data-kay-query'))).toEqual([])
  })

  it('ships none of route() to a site not importing it', async () => {
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const code = await Promise.all(chunks.map(async chunk => Bun.file(join(out, chunk)).text()))

    expect(code.some(text => text.includes('<button>Count'))).toBe(true)
    expect(code.filter(text => text.includes('route(): param'))).toEqual([])
  })

  it('ships route() to an island importing it, so the marker above finds it', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))

    try {
      await Bun.write(join(fixture, 'src/components/linker.kay'), '---\nimport { route } from \'kay\'\n---\nbutton(type="button" onClick={() => location.assign(route(\'/about\', { query: { a: 1 } }))}) Go\n')
      await Bun.write(join(fixture, 'src/routes/routed.kay'), '---\nimport Linker from \'../components/linker.kay\'\n---\nLinker\n')

      expect((await exportSite(elsewhere, fixture)).code).toBe(0)

      const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(elsewhere))
      const code = await Promise.all(chunks.map(async chunk => Bun.file(join(elsewhere, chunk)).text()))

      expect(code.filter(text => text.includes('route(): param'))).toHaveLength(1)
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('ships no code reporting browser errors, which no server would take', async () => {
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const code = await Promise.all(chunks.map(async chunk => Bun.file(join(out, chunk)).text()))

    expect(code.some(text => text.includes('<button>Count'))).toBe(true)
    expect(code.filter(text => text.includes('/_kay/error'))).toEqual([])
  })

  it('ships no code reading the build header, which a static host never sends, and still reads the build off the page', async () => {
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const code = await Promise.all(chunks.map(async chunk => Bun.file(join(out, chunk)).text()))

    expect(code.filter(text => text.includes('kay-reloaded'))).toHaveLength(1)
    expect(code.filter(text => text.includes('x-kay-build'))).toEqual([])
    expect(code.some(text => text.includes('meta[name="kay-build"]'))).toBe(true)
  })

  it('names each island\'s chunk by its file in the markup, under the mount point, and keeps every island\'s loader out of the entry', async () => {
    const home = (await get('/')).text
    const file = (/<slot data-component="src\/components\/counter\.kay"[^>]* data-chunk="([^"/]+\.js)"/).exec(home)![1]!
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const others = await Promise.all(chunks.filter(chunk => chunk !== `_kay/${file}`).map(async chunk => Bun.file(join(out, chunk)).text()))

    expect((await get(`/_kay/${file}`)).status).toBe(200)
    expect(others.some(text => text.includes('counter'))).toBe(false)
    expect(others.some(text => text.includes(file))).toBe(false)
    expect(home).toContain(`<link rel="modulepreload" href="/repo/_kay/${file}">`)
  })

  it('keeps the JS a page loads up front within its budget', async () => {
    await expectEagerJsWithin(EAGER_JS_BUDGET, (await get('/')).text, async url => Bun.file(join(out, url.slice(BASE.length))).text())
  })

  it('keeps what reloads a tab opened before a deploy in the files loaded up front, and in no chunk loaded after idle', async () => {
    const read = async (url: string) => Bun.file(join(out, url.slice(BASE.length))).text()
    const eager = await expectEagerJsWithin(EAGER_JS_BUDGET, (await get('/')).text, read)
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const holding = await Promise.all(chunks.map(async chunk => (await Bun.file(join(out, chunk)).text()).includes('kay-reloaded')))

    expect(eager.filter(code => code.includes('kay-reloaded'))).toHaveLength(1)
    // A new chunk the entry imports is checked not to load on idle before it is listed here.
    expect(lazyChunks(eager)).toEqual(LAZY_CHUNKS)
    // A chunk loaded later is gone once a deploy dropped the chunks, so the reload could not run from it.
    expect(holding.filter(Boolean)).toHaveLength(1)
  })

  it.each([
    ['fathom', '{ provider: \'fathom\', siteId: \'ABCDEFGH\' }', true],
    ['cloudflare', '{ provider: \'cloudflare\', token: \'tok-123\', consent: true }', true],
    ['fathom with consent false', '{ provider: \'fathom\', siteId: \'ABCDEFGH\', consent: false }', false],
    ['fathom with consent false and no line', '{ provider: \'fathom\', siteId: \'ABCDEFGH\', consent: false, info: false }', false],
    ['cloudflare with consent false', '{ provider: \'cloudflare\', token: \'tok-123\', consent: false }', false],
  ])('writes kay\'s notice script beside the pages of a static site for %s when it asks or shows the line', async (_name, options, asks) => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))
    const config = join(fixture, 'kay.config.ts')

    try {
      await Bun.write(config, (await Bun.file(config).text()).replace('extensions: [{', `extensions: [analytics(${options}), {`).replace('import { defineConfig }', 'import { analytics } from \'kay/analytics\'\nimport { defineConfig }'))

      const { code, errors } = await exportSite(elsewhere, fixture)

      expect(code).toBe(0)
      expect(errors).not.toContain('needs a running server')

      const home = await Bun.file(join(elsewhere, 'index.html')).text()

      // The line counts too: it loads the provider's script after kay's, and opts out through the same files.
      const lined = !options.includes('info: false') && options.includes('consent: false')

      expect(home.includes('data-consent')).toBe(asks)
      expect(home.includes('data-info')).toBe(lined)
      expect(existsSync(join(elsewhere, '_kay/analytics.js'))).toBe(asks || lined)
      expect(existsSync(join(elsewhere, '_kay/analytics/notice.js'))).toBe(asks || lined)
      expect(home.includes('src="https://cdn.usefathom.com/script.js"')).toBe(!asks && !lined && options.includes('fathom'))
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('ships the island title code to the page setting one alone, with the template it wraps the title in', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))
    const config = join(fixture, 'kay.config.ts')

    try {
      await Bun.write(config, (await Bun.file(config).text()).replace('  site: ', '  seo: { name: \'Repo\', titleTemplate: \'%s | Repo\' },\n  site: '))
      await Bun.write(join(fixture, 'src/routes/titled.kay'), '---\nconst room = signal(\'Lobby\')\n---\nhead\n  title {room()}\nh1 Titled\nbutton(onClick={() => room.set(\'Next\')}) Rename\n')

      const { code, errors } = await exportSite(elsewhere, fixture)

      expect(errors).toBe('')
      expect(code).toBe(0)

      const scripts = async (page: string) => {
        const html = await Bun.file(join(elsewhere, page)).text()
        const urls = [...html.matchAll(SCRIPT_URL)].map(match => match[1]!.slice(BASE.length))

        return { html, code: await Promise.all(urls.map(async url => Bun.file(join(elsewhere, url)).text())) }
      }
      const titled = await scripts('titled.html')
      const home = await scripts('index.html')

      expect(titled.html).toContain('<title>Lobby | Repo</title>')
      expect(titled.html).toContain('<meta name="kay-title" content="{&quot;template&quot;:&quot;%s | Repo&quot;,&quot;fallback&quot;:&quot;Repo&quot;}">')
      expect(titled.code.some(text => text.includes('kay-title'))).toBe(true)
      expect(home.html).not.toContain('kay-title')
      expect(home.code.join('').length).toBeGreaterThan(0)
      expect(home.code.filter(text => text.includes('kay-title'))).toEqual([])
      expect((await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(elsewhere))).length).toBeGreaterThan(0)
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('builds the same JS every time, so the budget above measures the source and not the run', async () => {
    const again = await mkdtemp(join(tmpdir(), 'kay-static-'))

    try {
      const { code, errors } = await exportSite(again)

      expect(errors).toBe('')
      expect(code).toBe(0)

      const scripts = async (dir: string): Promise<Record<string, string>> => Object.fromEntries(await Promise.all([...new Bun.Glob('_kay/**/*.js').scanSync(dir)].sort().map(async file => [file, await Bun.file(join(dir, file)).text()] as const)))
      const first = await scripts(out)

      expect(Object.keys(first).length).toBeGreaterThan(3)
      expect(await scripts(again)).toEqual(first)
    }
    finally {
      await rm(again, { recursive: true, force: true })
    }
  })

  it('writes the public files, the sitemap, robots.txt and kay\'s mark under the mount point, and 404.html', async () => {
    expect((await get('/humans.txt')).text).toBe('User-agent: test\n')
    // A static host's own dotfile goes along, a backup or another dotfile left behind does not.
    expect(await Bun.file(join(out, '.nojekyll')).exists()).toBe(true)
    expect(await Bun.file(join(out, 'humans.txt.bak')).exists()).toBe(false)
    expect(await Bun.file(join(out, '.secret')).exists()).toBe(false)
    expect((await get('/sitemap.xml')).text).toContain('<loc>https://x.example/repo/about</loc>')
    expect((await get('/sitemap.xml')).text).toContain('<loc>https://x.example/repo/posts/first</loc><lastmod>2026-03-04T10:00:00.000Z</lastmod>')
    expect((await get('/robots.txt')).text).toContain('Disallow: /repo/private\n\nSitemap: https://x.example/repo/sitemap.xml')
    expect((await get('/favicon.svg')).text).toBe(await Bun.file('src/server/favicon.svg').text())
    expect((await get('/about')).text).toContain('<link rel="icon" href="/repo/favicon.svg" type="image/svg+xml">')

    const missing = await get('/nowhere')

    expect(missing.status).toBe(404)
    expect(missing.text).toContain('<h1>Nothing here</h1>')
    expect(missing.text).not.toContain('kay-boot')
    // Written by the export rather than prerendered, it goes through the page hooks all the same.
    expect(missing.text).toMatch(/<!--linked from \/404\.html: [^>]*\.css[^>]*--><\/body>/)
  })

  it('writes each endpoint file to its path, once per param its prerender lists', async () => {
    expect((await get('/llms.txt')).text).toBe('# Static site\n')
    expect((await get('/data/first.json')).text).toBe('{"slug":"first"}')
  })

  it('turns a redirect into a page sending the browser on, and lists every one in _redirects', async () => {
    expect((await get('/old')).text).toContain('<meta http-equiv="refresh" content="0; url=/repo/about">')
    expect((await get('/old')).text).toStartWith('<!doctype html><html lang="en">')
    expect(await Bun.file(join(out, '_redirects')).text()).toBe('/repo/old /repo/about 301\n/repo/blog/:slug /repo/posts/:slug 301\n/repo/moved /repo/about 302\n/repo/temp /repo/about 302\n/repo/kept /repo/about 308\n')
  })

  it('writes the security headers a server would send as _headers and as an nginx include, HSTS left to nginx.conf', async () => {
    const headers = await Bun.file(join(out, '_headers')).text()
    const include = await Bun.file(join(out, 'headers.nginx.conf')).text()

    expect(headers).toStartWith('/*\n  ')
    expect(headers).toContain('\n  Content-Security-Policy: default-src \'self\'; ')
    expect(headers).toContain('\n  X-Content-Type-Options: nosniff')
    expect(headers).toContain('\n  Strict-Transport-Security: max-age=31536000')
    expect(include).toContain('add_header Content-Security-Policy "default-src \'self\'; ')
    expect(include).toContain('add_header X-Content-Type-Options "nosniff" always;')
    expect(include).toContain('add_header Permissions-Policy "')
    // The scaffold's nginx.conf sends HSTS itself, and a header sent twice is two headers.
    expect(include).not.toContain('Strict-Transport-Security')
    // Every line is one directive nginx reads: no quote or backslash left raw, nothing to expand.
    expect(include.trim().split('\n').filter(line => !(/^add_header [\w-]+ "(?:[^"\\$]|\\.)*" always;$/).test(line))).toEqual([])
  })

  it('covers every inline script and style of every exported page with a hash of the exported CSP', async () => {
    const { uncovered, checked } = await uncoveredInline(out)

    expect(checked).toBeGreaterThan(3)
    expect(uncovered).toEqual([])
  })

  it('covers the inline scripts and styles of a site without a base, its styles inlined', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))

    try {
      const config = join(fixture, 'kay.config.ts')

      await Bun.write(config, (await Bun.file(config).text()).replace('  base: \'/repo\',\n', '').replace('  inlineStyles: false,\n', ''))

      const { code, errors } = await exportSite(elsewhere, fixture)
      const { uncovered, checked } = await uncoveredInline(elsewhere)

      expect(errors).not.toContain('error')
      expect(code).toBe(0)
      expect(await Bun.file(join(elsewhere, 'index.html')).text()).toContain('<style')
      expect(checked).toBeGreaterThan(3)
      expect(uncovered).toEqual([])
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('escapes the quotes of a header for nginx and leaves out one it cannot spell', () => {
    const headers = { 'content-security-policy': 'default-src \'self\'; report-uri "x"', 'x-bad': 'a$b', 'x-multi': 'a\nb', 'strict-transport-security': 'max-age=1' }

    expect(nginxHeaders(headers)).toBe('add_header Content-Security-Policy "default-src \'self\'; report-uri \\"x\\"" always;\n')
    expect(nginxHeaders({})).toBe('# kay sends no security headers for this build.\n')
    expect(headersFile({ 'x-frame-options': 'SAMEORIGIN' })).toBe('/*\n  X-Frame-Options: SAMEORIGIN\n')
  })

  it('warns of the pages setting their own security and of CSP reports, keeps a public _headers, and writes no headers with security off', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))
    const config = join(fixture, 'kay.config.ts')
    const original = await Bun.file(config).text()

    try {
      await Bun.write(join(fixture, 'src/routes/embed.kay'), '--- server\nexport const page = { security: { csp: { \'frame-src\': [\'https://video.example\'] } } }\n---\nh1 Embed\n')
      await Bun.write(join(fixture, 'public/_headers'), '/*\n  X-Mine: yes\n')
      await Bun.write(config, original.replace('robots:', 'security: { reports: true },\n  robots:'))

      const reported = await exportSite(elsewhere, fixture)

      expect(reported.errors).toContain('/embed set')
      expect(reported.errors).toContain('security.reports: true sends CSP reports to an endpoint a static site lacks')
      expect(reported.errors).toContain('public/_headers is kept as it is')
      expect(reported.code).toBe(0)
      expect(await Bun.file(join(elsewhere, '_headers')).text()).toBe('/*\n  X-Mine: yes\n')

      const nginx = await Bun.file(join(elsewhere, 'headers.nginx.conf')).text()

      expect(nginx).toContain('add_header Content-Security-Policy')
      expect(nginx).not.toContain('Reporting-Endpoints')

      await Bun.write(config, original.replace('robots:', 'security: false,\n  robots:'))
      await rm(join(fixture, 'public/_headers'))
      await rm(join(fixture, 'src/routes/embed.kay'))

      const bare = await exportSite(elsewhere, fixture)

      expect(bare.code).toBe(0)
      expect(await Bun.file(join(elsewhere, 'headers.nginx.conf')).text()).toBe('# kay sends no security headers for this build.\n')
      expect(existsSync(join(elsewhere, '_headers'))).toBe(false)
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('names every page only a server could answer, and fails', async () => {
    const fixture = await fixtureCopy('static')
    const guarded = join(fixture, 'src/routes/members')
    const tags = join(fixture, 'src/routes/tags')
    const api = join(fixture, 'src/api')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))

    try {
      await Bun.write(join(guarded, '_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n')
      await Bun.write(join(guarded, 'index.kay'), 'h1 Members\n')
      await Bun.write(join(tags, '[tag].kay'), 'h1 Tag\n')
      await Bun.write(join(tags, 'gone.kay'), '--- server\nctx.redirect(\'/about\')\n---\np x\n')
      await Bun.write(join(api, 'ping.ts'), 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'pong\')\n')
      await Bun.write(join(tags, '[tag].json.ts'), 'export function GET() {\n  return \'{}\'\n}\n')

      const { code, errors } = await exportSite(elsewhere, fixture)

      expect(code).toBe(1)
      expect(errors).toContain('kay: 3 pages, 1 endpoint and 1 API module cannot be exported to static files, which no server answers for:')
      expect(errors).toContain('src/api/ping.ts: an API module answers requests, which only a server does; a file such as src/routes/llms.txt.ts exporting GET is written to a file')
      expect(errors).toContain('src/routes/tags/[tag].json.ts: it takes tag, so `prerender` lists the values to export')
      expect(errors).toContain('src/routes/tags/gone.kay: /tags/gone redirects to /about, which no static host does')
      expect(errors).toContain('src/routes/members/index.kay: a guard covers it, and only a server can run one per request')
      expect(errors).toContain('src/routes/tags/[tag].kay: it takes tag, so `prerender` lists the values to export')
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('refuses a page no guard covers on a site requiring guards, unless it sets guards: false', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))
    const config = join(fixture, 'kay.config.ts')

    try {
      await Bun.write(config, (await Bun.file(config).text()).replace('  site: ', '  requireGuards: true,\n  site: '))
      await Bun.write(join(fixture, 'src/routes/about.kay'), `--- server\nexport const page = { guards: false }\n---\n${await Bun.file(join(fixture, 'src/routes/about.kay')).text()}`)

      const { code, errors } = await exportSite(elsewhere, fixture)

      expect(code).toBe(1)
      expect(errors).toContain('src/routes/index.kay: requireGuards is on and no guard covers it; set `guards: false` in its `page` to export it')
      expect(errors).not.toContain('src/routes/about.kay:')
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('runs again into the directory an export failing halfway left', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))
    const endpoint = join(fixture, 'src/routes/llms.txt.ts')
    const served = await Bun.file(endpoint).text()

    try {
      await Bun.write(endpoint, 'export function GET() {\n  throw new Error("down")\n}\n')

      const failed = await exportSite(elsewhere, fixture)

      expect([failed.code, existsSync(join(elsewhere, 'index.html'))]).toEqual([1, true])

      await Bun.write(endpoint, served)

      const { code, errors } = await exportSite(elsewhere, fixture)

      expect(errors).not.toContain('holds files a static export did not write')
      expect([code, await Bun.file(join(elsewhere, 'llms.txt')).text()]).toEqual([0, '# Static site\n'])
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('renders the files it writes itself a few at a time', async () => {
    const fixture = await fixtureCopy('static')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))
    const flags = await mkdtemp(join(tmpdir(), 'kay-static-'))
    // Each endpoint waits for the other to have started, which a loop rendering one after the other never lets happen.
    const together = (own: string, other: string) => `import { existsSync, writeFileSync } from 'node:fs'\n\nexport async function GET() {\n  writeFileSync(${JSON.stringify(join(flags, own))}, '')\n\n  for (let waited = 0; waited < 100 && !existsSync(${JSON.stringify(join(flags, other))}); waited++)\n    await Bun.sleep(50)\n\n  return existsSync(${JSON.stringify(join(flags, other))}) ? 'together' : 'alone'\n}\n`

    try {
      await Bun.write(join(fixture, 'src/routes/first.txt.ts'), together('first', 'second'))
      await Bun.write(join(fixture, 'src/routes/second.txt.ts'), together('second', 'first'))

      const { code, errors } = await exportSite(elsewhere, fixture)

      expect(errors).not.toContain('kay:')
      expect([code, await Bun.file(join(elsewhere, 'first.txt')).text(), await Bun.file(join(elsewhere, 'second.txt')).text()]).toEqual([0, 'together', 'together'])
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
      await rm(flags, { recursive: true, force: true })
    }
  })

  it('never clears a directory it did not write', async () => {
    const foreign = await mkdtemp(join(tmpdir(), 'kay-static-'))

    try {
      await Bun.write(join(foreign, 'keep.txt'), 'mine')

      const { code, errors } = await exportSite(foreign)

      expect(code).toBe(1)
      expect(errors).toContain('holds files a static export did not write')
      expect(await Bun.file(join(foreign, 'keep.txt')).text()).toBe('mine')
    }
    finally {
      await rm(foreign, { recursive: true, force: true })
    }
  })
})
