import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { joinBase } from '../src/runtime/base'
import { pages } from '../src/server'
import { rebaseHtml } from '../src/server/base'
import { IMAGE_LINK } from '../src/server/prerender'
import { fixtureCopy } from './scratch'

const FIXTURE = resolve('tests/fixtures/static')
const CLI = resolve('src/cli.ts')
const BASE = '/repo'
// The gzipped JS a page with one small island loads before anything is clicked, a little above what it is: a change growing it raises this in the same commit, on purpose.
const EAGER_JS_BUDGET = 8_650
const SCRIPT_URL = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g
const STATIC_IMPORT = /(?:from|import)\s*"([^"]+\.js)"/g

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
    const image = (/<img src="\/repo(\/_kay\/images\/[\w-]+\.webp)"/).exec(home)![1]!

    const script = await get(entry)

    expect(script.status).toBe(200)
    expect(script.text).toContain('"/repo/_kay/env.js"')
    expect(home).toContain('<link rel="modulepreload" href="/repo/_kay/env.js">')
    expect((await get('/_kay/env.js')).text).toBe('export default {"KAY_TEST_STATIC_KEY":"static-key"}\n')
    expect((await get(stylesheet)).text).toContain('url(/repo/humans.txt)')
    expect((await get(image)).status).toBe(200)

    // The cut variants and the share card the page asks for are written too.
    const square = (/<img src="\/repo(\/_kay\/images\/[\w-]+-1x1\.webp)"/).exec(home)![1]!
    const card = (/<meta property="og:image" content="https:\/\/x\.example\/repo(\/_kay\/images\/[\w-]+-card\.jpg)">/).exec(home)![1]!

    expect((await get(square)).status).toBe(200)

    // A remote image's variants are downloaded and written as files, named after its URL.
    const remote = (/<img src="\/repo(\/_kay\/images\/remote-\w+-1000\.webp)" srcset="([^"]+)"/).exec(home)!
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
    expect(linked).toContain(named(/<img src="\/repo\/_kay\/images\/([\w-]+-1x1\.webp)"/))
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

  it('ships no code reporting browser errors, which no server would take', async () => {
    const chunks = await Array.fromAsync(new Bun.Glob('_kay/*.js').scan(out))
    const code = await Promise.all(chunks.map(async chunk => Bun.file(join(out, chunk)).text()))

    expect(code.some(text => text.includes('<button>Count'))).toBe(true)
    expect(code.filter(text => text.includes('/_kay/error'))).toEqual([])
  })

  it('keeps the JS a page loads up front within its budget', async () => {
    const pending = [...(await get('/')).text.matchAll(SCRIPT_URL)].map(match => match[1]!)
    const loaded = new Map<string, number>()

    // What the page links, and what those import statically; a dynamic `import()` waits for a visitor to need it.
    for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
      if (loaded.has(url))
        continue

      const code = await Bun.file(join(out, url.slice(BASE.length))).text()

      loaded.set(url, Bun.gzipSync(code).length)
      pending.push(...[...code.matchAll(STATIC_IMPORT)].map(match => new URL(match[1]!, `http://x${url}`).pathname))
    }

    const total = loaded.values().reduce((sum, size) => sum + size, 0)

    expect(total, `${total} bytes of gzipped JS load up front, over the ${EAGER_JS_BUDGET} budget: ${[...loaded].map(([url, size]) => `${url} ${size}`).join(', ')}`).toBeLessThanOrEqual(EAGER_JS_BUDGET)
  })

  it('writes the public files, the sitemap, robots.txt and kay\'s mark under the mount point, and 404.html', async () => {
    expect((await get('/humans.txt')).text).toBe('User-agent: test\n')
    expect((await get('/sitemap.xml')).text).toContain('<loc>https://x.example/repo/about</loc>')
    expect((await get('/robots.txt')).text).toContain('Sitemap: https://x.example/repo/sitemap.xml')
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
    expect(await Bun.file(join(out, '_redirects')).text()).toBe('/repo/old /repo/about 301\n/repo/blog/:slug /repo/posts/:slug 301\n')
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

describe('base on a server', () => {
  it('puts a route starting like the base under it too, and rewrites srcset and inline styles', async () => {
    expect(joinBase('/blog', '/blog/hello')).toBe('/blog/blog/hello')
    expect(joinBase('/blog', '//cdn.example/x.js')).toBe('//cdn.example/x.js')
    expect(joinBase('/blog', 'relative.png')).toBe('relative.png')

    const html = await rebaseHtml(new Response('<img srcset="/a.webp 320w, /b.webp 640w"><style>body { background: url("/bg.png") }</style><object data="/x.svg"></object>'), '/repo').text()

    expect(html).toBe('<img srcset="/repo/a.webp 320w, /repo/b.webp 640w"><style>body { background: url("/repo/bg.png") }</style><object data="/repo/x.svg"></object>')
  })

  it('puts the links, assets and redirects of every page under the mount point', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/static/src/routes', prebuilt: false, security: false, site: 'https://x.example', base: '/repo/', redirects: { '/old': '/about' } }))
    const visit = async (path: string) => app.handle(new Request(`http://localhost${path}`))
    const about = await (await visit('/about')).text()

    expect(about).toContain('<a class="about" href="/repo/about" aria-current="page">About</a>')
    expect(about).toMatch(/<link rel="stylesheet" href="\/repo\/_kay\/[\w-]+\.css">/)
    expect((await visit('/old')).headers.get('location')).toBe('/repo/about')
    expect((await visit('/about/')).headers.get('location')).toBe('/repo/about')

    const favicon = new Elysia().use(await pages({ routes: 'tests/fixtures/static/src/routes', prebuilt: false, security: false, base: '/repo', favicon: 'tests/fixtures/static/src/hero.png' }))
    const manifest = await (await favicon.handle(new Request('http://localhost/manifest.webmanifest'))).json() as { start_url: string, icons: { src: string }[] }

    expect(manifest.start_url).toBe('/repo/')
    expect(manifest.icons[0]!.src).toBe('/repo/icon-192.png')
    // No seo.description, no description.
    expect(manifest).not.toHaveProperty('description')
    await expect(pages({ routes: 'tests/fixtures/static/src/routes', prebuilt: false, base: 'repo' })).rejects.toThrow('base is repo, which is no path such as /docs')
  })
})
