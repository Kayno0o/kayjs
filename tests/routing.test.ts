import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { check } from '../src/check'
import { joinBase, localPath } from '../src/runtime/base'
import { integer } from '../src/runtime/params'
import { pages } from '../src/server'
import { routerShapes, shapeParams } from '../src/server/params'
import { readRedirects, redirectProblems } from '../src/server/redirects'
import { routeChain, routeOf } from '../src/server/routes'
import { prerendered } from './prerendered'
import { fixtureCopy } from './scratch'

const FIXTURE = 'tests/fixtures/routing'
const routes = `${FIXTURE}/src/routes`
const redirects = { '/old/:slug': '/items/:slug', '/legacy/*': '/blog/*', '/temp': { to: '/about', permanent: false }, '/go/*': '/*' }
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

  it('run a group\'s guard on the pages inside it', async () => {
    expect(await get('/lounge')).toMatchObject({ status: 302, location: '/about' })
  })

  it('wrap no page exporting layouts = false, and start the chain at a layout exporting it', async () => {
    const { html } = await get('/bare')

    expect(html).toContain('<p class="bare">Bare</p>')
    expect(html).not.toContain('Root')

    const docs = await get('/docs/a')

    expect(docs.html).toContain('<div class="docs"><p class="path">Docs at a</p></div>')
    expect(docs.html).not.toContain('Root')
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
    const copy = await fixtureCopy('routing')

    try {
      await Bun.write(join(copy, 'src/routes/x/[id=nothing].kay'), 'p x\n')

      await expect(pages({ routes: `${copy}/src/routes`, prebuilt: false })).rejects.toThrow('names the matcher nothing, which is neither')
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('the page an action was posted from', () => {
  const matchers = new Map([['integer', integer]])
  const paramsOf = (file: string, path: string, prefix = '', pattern?: string) => {
    const route = { ...routeOf('/r', `/r/${file}`)!, layouts: [], special: {}, guards: [] }

    for (const shape of routerShapes(route, prefix, pattern ?? route.pattern)) {
      const params = shapeParams(shape, route, path, matchers)

      if (params)
        return params
    }

    return undefined
  }

  it('reads its params as a request of it would give them, decoded and matched', () => {
    expect(paramsOf('orgs/[org].kay', '/orgs/acme')).toEqual({ org: 'acme' })
    expect(paramsOf('orgs/[org].kay', '/orgs/acme/')).toEqual({ org: 'acme' })
    expect(paramsOf('orgs/[org].kay', '/orgs/a%20b')).toEqual({ org: 'a b' })
    expect(paramsOf('orgs/[org].kay', '/orgs/a%2Fb')).toEqual({ org: 'a/b' })
    expect(paramsOf('docs/[...slug].kay', '/docs/a/b%20c')).toEqual({ slug: 'a/b c' })
    expect(paramsOf('blog/[[page]].kay', '/blog')).toEqual({})
    expect(paramsOf('blog/[[page]].kay', '/blog/2')).toEqual({ page: '2' })
    expect(paramsOf('items/[id=integer].kay', '/items/7')).toEqual({ id: 7 })
    expect(paramsOf('orgs/[org].kay', '/fr/organisations/acme', '/fr', '/organisations/:org')).toEqual({ org: 'acme' })
  })

  it('reads none from a page its route does not serve', () => {
    for (const path of ['/orgs', '/orgs/', '/orgs//x', '/orgs/acme/x', '/orgs/%E0', '/teams/acme'])
      expect(paramsOf('orgs/[org].kay', path)).toBeUndefined()

    expect(paramsOf('items/[id=integer].kay', '/items/x')).toBeUndefined()
    expect(paramsOf('orgs/[org].kay', '/orgs/acme', '/fr', '/organisations/:org')).toBeUndefined()
  })
})

describe('redirects', () => {
  it('send old paths elsewhere, params, rest and query carried over', async () => {
    expect(await get('/old/my%20post?ref=1')).toMatchObject({ status: 308, location: '/items/my%20post?ref=1' })
    expect(await get('/legacy/a/b')).toMatchObject({ status: 308, location: '/blog/a/b' })
    expect(await get('/temp')).toMatchObject({ status: 307, location: '/about' })
  })

  it('never send a rest of the path off the site', async () => {
    expect((await get('/go//evil.example')).location).toBe('/evil.example')
  })

  it('refuse a target naming what the old path lacks, and a path a page serves', async () => {
    expect(() => readRedirects({ '/a': '/b/:id' })).toThrow('goes to /b/:id, whose :id its path has none of')
    await expect(pages({ routes, prebuilt: false, redirects: { '/about': '/bare' } })).rejects.toThrow('the redirect from /about takes a path a page serves')
    await expect(pages({ routes, prebuilt: false, redirects: { '/docs/*': '/about' } })).rejects.toThrow('the redirect from /docs/* takes a path a page serves')
    // A param and a catch-all are two router paths, the param tried first.
    const beside = new Elysia().use(await pages({ routes, prebuilt: false, security: false, redirects: { '/docs/:page': '/about' } }))

    expect((await get('/docs/a', beside)).location).toBe('/about')
    expect((await get('/docs/a/b', beside)).html).toContain('Docs at a/b')
  })

  it('are checked against what the site serves', () => {
    const served = ['/items/:id', '/blog', '/:lang/hello', '/docs/*', '/robots.txt']
    const problems = redirectProblems({ '/a': '/items/9', '/b': '/blog/', '/c': 'https://elsewhere.example/x', '/d': '/nowhere', '/e/*': '/fr/hello?x', '/f': '/docs/', '/g': '/docs', '/h': '/d', '/i': '/robots.txt' }, served)

    expect(problems).toEqual(['the redirect from /d goes to /nowhere, which nothing on the site serves', 'the redirect from /g goes to /docs, which nothing on the site serves'])
  })
})

describe('localPath', () => {
  it('keeps a path of the site and falls back for anything a browser would take elsewhere', () => {
    expect(localPath('/account?tab=keys#top', '/')).toBe('/account?tab=keys#top')
    expect(localPath('/café', '/')).toBe('/caf%C3%A9')

    for (const next of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', '/\n/evil.example', '/.//evil.example', '/..//evil.example', '/%2e%2e//evil.example', '/a/..//evil.example', '/x/../\\evil.example', '\\\\evil.example', 'evil.example', 'javascript:alert(1)', '', undefined, ['/a']])
      expect(localPath(next, '/home')).toBe('/home')
  })

  // Hostile values that must fall back, as kayjs-auth relies on them, and the invariant for every answer: on the site both resolved raw and decoded once, under a mount point too.
  const hostile = ['/%2F/evil.example', '/%2f/evil.example', '/%2F%2Fevil.example', '/%5Cevil.example', '/./%5Cevil.example', '/.%2f/evil.example', '/a/..%2f/evil.example', '/%2e%2e%2f%2e%2e%2f/evil.example', '/%09/evil.example', '/%0a/evil.example', '/%0d/evil.example', '/%0A/evil.example', '/%09%0a%0d/evil.example', '/%09%5cevil.example', '/%09/%2fevil.example', '/\t\\evil.example', '\t//evil.example', ' //evil.example', '//nowhere.invalid/x', '/\r/evil.example', '/%2509/evil.example', '/%250a/evil.example', '/%252F/evil.example', '/%255cevil.example', '/%252509/evil.example', '/%2509/evil.example?%25', '/%2509/evil.example/%25zz', '/%2509/evil.example#100%25', '/%250a/evil.example?q=%25', `/%${'25'.repeat(9)}09/evil.example`, '/%E0%A4%A', '/%E0%A4%A?x=1', '/a%3Fb%', '/%E0%A4%A#%', '/a%?x=1', '/%2F/evil.example?x=%', '/%2509/evil.example?x=%zz', '/%09/%E0%A4%A', 'http:evil.example', '/a\\b', '/a\0b', '/a\x7Fb']
  const legit = ['/dashboard', '/a/b?x=1#top', '/a/%2F', '/a/%09b', '/a?next=%09//x', '/a?q=%0a', '/é?q=é', '/a b', '/a/%5Cb', '/%7Euser', '/a/..%2fb', '/.%09/evil.example', '/a/..%09/evil.example', '/ /evil.example', '/%2e%09/evil.example', '/a?q=100%25', '/%3F%2F/evil.example', '/%253F%252F/evil.example']

  it('falls back for a path that leaves the site once decoded, at any depth of encoding', () => {
    for (const next of hostile)
      expect([next, localPath(next, '/home')]).toEqual([next, '/home'])
  })

  it('keeps a bare percent after the path, and reads only a literal question mark or hash as its end', () => {
    const kept = ['/a?x=%25zz#%', '/a?x=%', '/a#%', '/a?x=%zz&y=%E0%A4%A#100%', '/a/b?next=%09//x%', '/%3F%2F/evil.example', '/%253F%252F/evil.example', '/a%23?%', '/a/%09b', '/a/%5Cb', '/a?q=100%25']

    expect(kept.map(next => localPath(next, '/'))).toEqual(kept)
  })

  it('answers only paths that stay on the site, resolved raw or decoded once, under a mount point too', () => {
    for (const next of [...hostile, ...legit]) {
      const answer = localPath(next, '/')

      for (const form of [answer, decodeURIComponent(answer), joinBase('/docs', answer)])
        expect([next, new URL(form, 'http://site.test').origin]).toEqual([next, 'http://site.test'])

      expect([next, joinBase('/docs', answer).startsWith('/docs/')]).toEqual([next, true])
    }
  })

  it('answers a path of the site as a browser resolves it', () => {
    expect(localPath('/a/./b/../c?next=//x#top', '/')).toBe('/a/c?next=//x#top')
    expect(localPath('/a/%2F', '/')).toBe('/a/%2F')
    expect(localPath('/search?q=100%', '/')).toBe('/search?q=100%')
    expect(localPath(' /account', '/')).toBe('/account')
    expect(['/../x', '/a?', '/a b'].map(next => localPath(next, '/'))).toEqual(['/x', '/a', '/a%20b'])
    expect(localPath(localPath('/a/./é', '/'), '/')).toBe(localPath('/a/./é', '/'))
  })

  it('leaves no control character a redirect would refuse', () => {
    expect(localPath('/a\tb', '/')).toBe('/ab')
  })
})

describe('trailing slashes', () => {
  it('redirect to the URL without one by default, to the one with always, and serve both with ignore', async () => {
    const always = new Elysia().use(await pages({ routes, prebuilt: false, security: false, trailingSlash: 'always' }))
    const ignore = new Elysia().use(await pages({ routes, prebuilt: false, security: false, trailingSlash: 'ignore' }))

    expect(await get('/about/?x=1')).toMatchObject({ status: 308, location: '/about?x=1' })
    expect(await get('/about', always)).toMatchObject({ status: 308, location: '/about/' })
    expect((await get('/blog/2/', always)).html).toContain('<p class="page">Page 2, a number</p>')
    expect(await get('/docs/a', always)).toMatchObject({ status: 308, location: '/docs/a/' })
    expect((await get('/docs/a/', always)).html).toContain('Docs at a<')
    expect((await get('/about/', ignore)).status).toBe(200)
    expect((await get('/about', ignore)).status).toBe(200)
  })

  it('write sitemap and canonical URLs as the setting has them', async () => {
    const always = new Elysia().use(await pages({ routes, prebuilt: false, security: false, trailingSlash: 'always', site: 'https://x.example' }))

    expect((await get('/sitemap.xml', always)).html).toContain('<loc>https://x.example/about/</loc>')
    expect((await get('/about/', always)).html).toContain('<link rel="canonical" href="https://x.example/about/">')
  })
})

describe('prerendering', () => {
  const build = prerendered({ routes })

  it('renders an optional param\'s path with and without it, the matcher\'s value handed over', async () => {
    const dir = build.pages

    // The two paths of the optional param, and the pages reading nothing from a request.
    expect(build.count()).toBe(5)
    expect(await Bun.file(join(dir, 'blog.html')).text()).toContain('<p class="page">Page 1, a undefined</p>')
    expect(await Bun.file(join(dir, 'blog/2.html')).text()).toContain('<p class="page">Page 2, a number</p>')
  })
})

describe('kay check', () => {
  it('types each param as its matcher returns, optional ones as possibly missing, and reports a redirect to nowhere', async () => {
    // The sitemap kay serves counts as served; nothing else on the fixture is reported.
    const diagnostics = await check(FIXTURE, { redirects: { '/x': '/sitemap.xml', '/y': '/nowhere' } })

    expect(diagnostics.map(diagnostic => diagnostic.message)).toEqual(['the redirect from /y goes to /nowhere, which nothing on the site serves'])
  })

  it('reports a matcher nobody provides at the page naming it', async () => {
    const copy = await fixtureCopy('routing')
    const page = join(copy, 'src/routes/x/[id=nothing].kay')

    try {
      await Bun.write(page, 'p x\n')

      expect((await check(copy)).map(({ file, message }) => ({ file: file.slice(file.indexOf(copy)), message }))).toEqual([{ file: page, message: 'names the matcher nothing, which is neither src/params/nothing.ts nor one kay ships: integer, slug, uuid' }])
    }
    finally {
      await rm(copy, { recursive: true, force: true })
    }
  })
})

describe('routeChain', () => {
  it('lists a route\'s layouts then its page once, rebuilt when the route\'s file or layouts change', () => {
    const layouts = ['/a/_layout.kay', '/a/b/_layout.kay']
    const chain = routeChain({ layouts, file: '/a/b/page.kay' })

    expect(chain.files).toEqual(['/a/_layout.kay', '/a/b/_layout.kay', '/a/b/page.kay'])
    expect(chain.key).toBe(chain.files.join('\0'))
    expect(routeChain({ layouts, file: '/a/b/page.kay' })).toBe(chain)
    expect(routeChain({ layouts, file: '/a/b/other.kay' }).files.at(-1)).toBe('/a/b/other.kay')
    expect(routeChain({ layouts: [...layouts], file: '/a/b/page.kay' }).files).toEqual(chain.files)
  })
})
