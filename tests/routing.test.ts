import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { check } from '../src/check'
import { pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { prerenderPages } from '../src/server/prerender'
import { readRedirects, redirectProblems } from '../src/server/redirects'

const FIXTURE = 'tests/fixtures/routing'
const routes = `${FIXTURE}/src/routes`
const redirects = { '/old/:slug': '/items/:slug', '/legacy/*': '/blog/*', '/temp': { to: '/about', permanent: false } }
const app = new Elysia().use(await pages({ routes, prebuilt: false, security: false, redirects }))

async function get(path: string, served = app): Promise<{ status: number, html: string, location: string | null }> {
  const response = await served.handle(new Request(`http://localhost${path}`))

  return { status: response.status, html: await response.text(), location: response.headers.get('location') }
}

describe('route groups and layouts', () => {
  it('leave a group out of the URL while its layout wraps the pages inside', async () => {
    const { status, html } = await get('/about')

    expect(status).toBe(200)
    expect(html).toContain('<header class="root">Root</header><main><div class="marketing"><h1>About</h1></div></main>')
  })

  it('wrap no page exporting layouts = false', async () => {
    const { html } = await get('/bare')

    expect(html).toContain('<p class="bare">Bare</p>')
    expect(html).not.toContain('Root')
  })
})

describe('optional params', () => {
  it('serve the path with and without their segment', async () => {
    expect((await get('/blog')).html).toContain('<p class="page">Page 1, a undefined</p>')
    expect((await get('/blog/2')).html).toContain('<p class="page">Page 2, a number</p>')
    expect((await get('/hello')).html).toContain('<p class="hello">Hello in en</p>')
    expect((await get('/fr/hello')).html).toContain('<p class="hello">Hello in fr</p>')
  })

  it('answer 404 where their matcher refuses the segment and no other page takes it', async () => {
    expect((await get('/blog/two')).status).toBe(404)
  })
})

describe('param matchers', () => {
  it('hand the page what they return, kay\'s own and the project\'s', async () => {
    expect((await get('/items/41')).html).toContain('<p class="id">Item 42</p>')
    expect((await get('/n/8')).html).toContain('<p class="even">Half 4</p>')
  })

  it('pass what they refuse to the page without one serving the same path', async () => {
    expect((await get('/items/forty')).html).toContain('<p class="slug">Slug forty</p>')
    expect((await get('/n/7')).html).toContain('<p class="odd">Odd 7</p>')
  })

  it('stop the server when one names a matcher nobody provides', async () => {
    const dir = join(process.cwd(), FIXTURE, 'src/routes/x')

    try {
      await Bun.write(join(dir, '[id=nothing].kay'), 'p x\n')

      await expect(pages({ routes, prebuilt: false })).rejects.toThrow('names the matcher nothing, which is neither')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('redirects', () => {
  it('send old paths elsewhere, params, rest and query carried over', async () => {
    expect(await get('/old/my%20post?ref=1')).toMatchObject({ status: 308, location: '/items/my%20post?ref=1' })
    expect(await get('/legacy/a/b')).toMatchObject({ status: 308, location: '/blog/a/b' })
    expect(await get('/temp')).toMatchObject({ status: 307, location: '/about' })
  })

  it('refuse a target naming what the old path lacks, and a path a page serves', async () => {
    expect(() => readRedirects({ '/a': '/b/:id' })).toThrow('goes to /b/:id, whose :id its path has none of')
    await expect(pages({ routes, prebuilt: false, redirects: { '/about': '/bare' } })).rejects.toThrow('the redirect from /about takes a path a page serves')
  })

  it('are checked against what the site serves', () => {
    expect(redirectProblems({ '/a': '/items/9', '/b': '/blog', '/c': 'https://elsewhere.example/x', '/d': '/nowhere', '/e/*': '/fr/hello?x' }, ['/items/:id', '/blog', '/:lang/hello'], ['/robots.txt'])).toEqual(['the redirect from /d goes to /nowhere, which no page or public file serves'])
  })
})

describe('trailing slashes', () => {
  it('redirect to the URL without one by default, to the one with always, and serve both with ignore', async () => {
    const always = new Elysia().use(await pages({ routes, prebuilt: false, security: false, trailingSlash: 'always' }))
    const ignore = new Elysia().use(await pages({ routes, prebuilt: false, security: false, trailingSlash: 'ignore' }))

    expect(await get('/about/?x=1')).toMatchObject({ status: 308, location: '/about?x=1' })
    expect(await get('/about', always)).toMatchObject({ status: 308, location: '/about/' })
    expect((await get('/blog/2/', always)).html).toContain('<p class="page">Page 2, a number</p>')
    expect((await get('/about/', ignore)).status).toBe(200)
    expect((await get('/about', ignore)).status).toBe(200)
  })
})

describe('prerendering', () => {
  it('renders an optional param\'s path with and without it, the matcher\'s value handed over', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      expect(await prerenderPages(root, { routes }, (await readClient(root))!)).toBe(2)
      expect(await Bun.file(join(root, '.kay/client/pages/blog.html')).text()).toContain('<p class="page">Page 1, a undefined</p>')
      expect(await Bun.file(join(root, '.kay/client/pages/blog/2.html')).text()).toContain('<p class="page">Page 2, a number</p>')
    }
    finally {
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })
})

describe('kay check', () => {
  it('types each param as its matcher returns, optional ones as possibly missing, and reports a redirect to nowhere', async () => {
    expect(await check(FIXTURE)).toEqual([])

    const diagnostics = await check(FIXTURE, { redirects: { '/x': '/nowhere' } })

    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual(['the redirect from /x goes to /nowhere, which no page or public file serves'])
  })
})
