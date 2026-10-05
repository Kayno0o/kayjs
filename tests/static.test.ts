import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { joinBase } from '../src/runtime/base'
import { pages } from '../src/server'
import { rebaseHtml } from '../src/server/base'

const FIXTURE = resolve('tests/fixtures/static')
const CLI = resolve('src/cli.ts')
const BASE = '/repo'

let out: string
let server: ReturnType<typeof Bun.serve>

async function exportSite(outdir: string): Promise<{ code: number, errors: string }> {
  const child = Bun.spawn([process.execPath, CLI, 'build', FIXTURE, '--no-check', '--static', '--outdir', outdir], { stdout: 'pipe', stderr: 'pipe' })
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
  await rm(out, { recursive: true, force: true })
})

describe('kay build --static', () => {
  it('writes every page, linked under the mount point, as a plain file server finds it', async () => {
    const home = await get('/')

    expect(home.status).toBe(200)
    expect(home.text).toContain('<a class="home" href="/repo/">Home</a><a class="about" href="/repo/about">About</a>')
    expect((await get('/about')).text).toContain('<h1>About</h1>')
    expect((await get('/about/')).text).toContain('<h1>About</h1>')
    expect((await get('/posts/first')).text).toContain('<h1>Post first</h1>')
  })

  it('serves the islands, stylesheets and image variants from their files, compressed copies beside them', async () => {
    const home = (await get('/')).text
    const entry = (/<script type="module" src="\/repo(\/_kay\/entry-[\w-]+\.js)">/).exec(home)![1]!
    const stylesheet = (/<link rel="stylesheet" href="\/repo(\/_kay\/[\w-]+\.css)">/).exec(home)![1]!
    const image = (/<img src="\/repo(\/_kay\/images\/[\w-]+\.webp)"/).exec(home)![1]!

    expect((await get(entry)).status).toBe(200)
    expect((await get(stylesheet)).text).toContain('url(/repo/humans.txt)')
    expect((await get(image)).status).toBe(200)
    expect(home).toContain('<slot data-component="src/components/counter.kay"')
    expect(await Bun.file(join(out, '_kay', `${entry.slice('/_kay/'.length)}.br`)).exists()).toBe(true)
    expect(await Bun.file(join(out, 'index.html.gz')).exists()).toBe(true)
  })

  it('writes the public files, the sitemap and robots.txt under the mount point, and 404.html', async () => {
    expect((await get('/humans.txt')).text).toBe('User-agent: test\n')
    expect((await get('/sitemap.xml')).text).toContain('<loc>https://x.example/repo/about</loc>')
    expect((await get('/robots.txt')).text).toContain('Sitemap: https://x.example/repo/sitemap.xml')

    const missing = await get('/nowhere')

    expect(missing.status).toBe(404)
    expect(missing.text).toContain('<h1>Nothing here</h1>')
  })

  it('turns a redirect into a page sending the browser on, and lists every one in _redirects', async () => {
    expect((await get('/old')).text).toContain('<meta http-equiv="refresh" content="0; url=/repo/about">')
    expect(await Bun.file(join(out, '_redirects')).text()).toBe('/repo/old /repo/about 301\n/repo/blog/:slug /repo/posts/:slug 301\n')
  })

  it('names every page only a server could answer, and fails', async () => {
    const guarded = join(FIXTURE, 'src/routes/members')
    const tags = join(FIXTURE, 'src/routes/tags')
    const api = join(FIXTURE, 'src/api')
    const elsewhere = await mkdtemp(join(tmpdir(), 'kay-static-'))

    try {
      await Bun.write(join(guarded, '_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n')
      await Bun.write(join(guarded, 'index.kay'), 'h1 Members\n')
      await Bun.write(join(tags, '[tag].kay'), 'h1 Tag\n')
      await Bun.write(join(tags, 'gone.kay'), '--- server\nctx.redirect(\'/about\')\n---\np x\n')
      await Bun.write(join(api, 'ping.ts'), 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => \'pong\')\n')

      const { code, errors } = await exportSite(elsewhere)

      expect(code).toBe(1)
      expect(errors).toContain('kay: 3 pages and 1 API module cannot be exported to static files, which no server answers for:')
      expect(errors).toContain('src/api/ping.ts: an API module answers requests, which only a server does')
      expect(errors).toContain('src/routes/tags/gone.kay: /tags/gone redirects to /about, which no static host does')
      expect(errors).toContain('src/routes/members/index.kay: a guard covers it, and only a server can run one per request')
      expect(errors).toContain('src/routes/tags/[tag].kay: it takes tag, so `prerender` lists the values to export')
    }
    finally {
      await rm(guarded, { recursive: true, force: true })
      await rm(tags, { recursive: true, force: true })
      await rm(api, { recursive: true, force: true })
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
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/static/src/routes', prebuilt: false, security: false, base: '/repo/', redirects: { '/old': '/about' } }))
    const visit = async (path: string) => app.handle(new Request(`http://localhost${path}`))
    const about = await (await visit('/about')).text()

    expect(about).toContain('<a class="about" href="/repo/about">About</a>')
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
