import { chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { openSqlite } from '../src/runtime/sqlite.server'
import { addRuntimeRedirect, removeRuntimeRedirect, runtimeRedirects } from '../src/server/library'
import { dropStore, missingPaths, pageRequested, sharedStore } from '../src/server/not-found'
import { configuredRedirects, knowRuntimeRules, missingRedirector, sitePaths } from '../src/server/runtime-redirect-api'
import { answerFor, RedirectRefusedError, redirectSet } from '../src/server/runtime-redirects'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const rules = { hosts: [] as string[], configured: {} as Record<string, string> }

function setOf() {
  return redirectSet(new Database(':memory:'))
}

describe('adding a runtime redirect refuses what could open a redirect', () => {
  const hostile = ['//evil.example', '//evil.example/x', '/\\evil.example', '\\evil.example', '\\\\evil.example', 'https://evil.example/x', 'http://evil.example', 'javascript:alert(1)', 'data:text/html,x', '/a\r\nSet-Cookie: x=1', '/a\nb', '/a b', '/a\tb', 'evil.example', '', 'https://user:pass@evil.example/', '/a\\b']

  for (const target of hostile) {
    it(`target ${JSON.stringify(target)}`, () => {
      const set = setOf()

      expect(() => set.add('/old', target, undefined, rules)).toThrow()
      expect(set.list()).toEqual([])
    })
  }

  it('refuses a path that is no path, a kay path, a status that is none', () => {
    const set = setOf()

    for (const from of ['//evil.example', '/\\x', 'old', '', '/a\r\nb', '/_kay/island', `/${'a'.repeat(600)}`])
      expect(() => set.add(from, '/new', undefined, rules)).toThrow()

    expect(() => set.add('/old', '/new', 200 as never, rules)).toThrow(/status/)
  })

  it('refuses a target naming a param its path has none of', () => {
    expect(() => setOf().add('/old', '/new/:slug', undefined, rules)).toThrow(/slug/)
  })

  it('allows another host only when the app lists it, without credentials', () => {
    const set = setOf()
    const allowed = { ...rules, hosts: ['example.org'] }

    expect(set.add('/a', 'https://example.org/x', undefined, allowed).to).toBe('https://example.org/x')
    expect(() => set.add('/b', 'https://example.org.evil.example/x', undefined, allowed)).toThrow()
    expect(() => set.add('/c', 'https://example.org@evil.example/x', undefined, allowed)).toThrow()
    expect(() => set.add('/d', 'ftp://example.org/x', undefined, allowed)).toThrow()
  })

  it('refuses a loop, direct, through the set or through the config', () => {
    const set = setOf()

    expect(() => set.add('/a', '/a', undefined, rules)).toThrow(/loop/)
    expect(() => set.add('/a', '/a/', undefined, rules)).toThrow(/loop/)
    expect(() => set.add('/a', '/a?x=1', undefined, rules)).toThrow(/loop/)

    set.add('/b', '/c', undefined, rules)
    set.add('/c', '/d', undefined, rules)

    expect(() => set.add('/d', '/b', undefined, rules)).toThrow(/loop/)
    expect(() => set.add('/x', '/y', undefined, { ...rules, configured: { '/y': '/x' } })).toThrow(/loop/)
    expect(() => set.add('/cfg', '/z', undefined, { ...rules, configured: { '/cfg': '/z' } })).toThrow(/kay\.config/)
  })

  it('refuses a target no page serves when the server knows its pages', () => {
    const set = setOf()
    const known = { ...rules, served: () => ['/about', '/blog/:slug', '/docs/*'] }

    expect(() => set.add('/old', '/nothing-here', undefined, known)).toThrow(/nothing on the site serves/)
    expect(set.add('/old', '/about/', undefined, known).to).toBe('/about/')
    expect(set.add('/old2', '/blog/hello?x=1', undefined, known).to).toBe('/blog/hello?x=1')
    expect(set.add('/old3', '/docs/a/b', undefined, known).to).toBe('/docs/a/b')
    expect(set.add('/chain', '/old', undefined, known).to).toBe('/old')
  })

  it('keeps at most so many', () => {
    const set = setOf()

    for (let index = 0; index < 1000; index++)
      set.add(`/old-${index}`, '/new', undefined, rules)

    expect(() => set.add('/one-more', '/new', undefined, rules)).toThrow(/1000/)
    expect(set.add('/old-1', '/other', undefined, rules).to).toBe('/other')
  })
})

describe('answering a missing path', () => {
  it('matches exact paths with or without a slash, and keeps the query', () => {
    const set = setOf()

    set.add('/old', '/new', 301, rules)

    expect(answerFor(set, '/old', '?a=1', [])).toEqual({ location: '/new?a=1', status: 301 })
    expect(answerFor(set, '/old/', '', [])).toEqual({ location: '/new', status: 301 })
    expect(answerFor(set, '/Old', '', [])).toBeUndefined()
    expect(answerFor(set, '/other', '', [])).toBeUndefined()
  })

  it('fills :params encoded and a final * as sent', () => {
    const set = setOf()

    set.add('/blog/:slug', '/posts/:slug', undefined, rules)
    set.add('/docs/*', '/guide/*', undefined, rules)

    expect(answerFor(set, '/blog/caf%C3%A9', '', [])?.location).toBe('/posts/caf%C3%A9')
    expect(answerFor(set, '/docs/a/b', '', [])?.location).toBe('/guide/a/b')
    expect(answerFor(set, '/docs', '', [])?.location).toBe('/guide/')
    expect(answerFor(set, '/blog/a/b', '', [])).toBeUndefined()
  })

  it('never lets a star or a param carry the visitor to another host', () => {
    const set = setOf()

    set.add('/go/*', '/*', undefined, rules)
    set.add('/p/:x', '/:x', undefined, rules)

    expect(answerFor(set, '/go//evil.example', '', [])?.location).toBe('/evil.example')
    // Encoded slashes are refused too: an app or proxy that decodes before it resolves would read them as a second slash.
    expect(answerFor(set, '/go/%2Fevil.example', '', [])).toBeUndefined()
    expect(answerFor(set, '/go/\\evil.example', '', [])).toBeUndefined()
    expect(answerFor(set, '/go/%5Cevil.example', '', [])).toBeUndefined()
    expect(answerFor(set, '/p/%2F%2Fevil.example', '', [])).toBeUndefined()
    expect(answerFor(set, '/p/%E0%A4%A', '', [])).toBeUndefined()
  })

  it('answers nothing for a row written to the file by other means that leaves the site', () => {
    const db = new Database(':memory:')
    const set = redirectSet(db)

    for (const [from, to] of [['/a', '//evil.example'], ['/b', '/\\evil.example'], ['/c', 'https://evil.example/'], ['/d', 'javascript:alert(1)'], ['/e', '/x\r\ny']])
      db.run('INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES (?, ?, 308, 0, 0)', [from!, to!])

    for (const from of ['/a', '/b', '/c', '/d', '/e'])
      expect(answerFor(set, from, '', [])).toBeUndefined()

    expect(answerFor(set, '/c', '', ['evil.example'])?.location).toBe('https://evil.example/')
  })

  it('answers neither of two redirects that two editors added to each other at once', () => {
    const db = new Database(':memory:')
    const set = redirectSet(db)

    for (const [from, to] of [['/a', '/b'], ['/b', '/a']])
      db.run('INSERT INTO kay_redirects (path, target, status, pattern, added_at) VALUES (?, ?, 308, 0, 0)', [from!, to!])

    expect(answerFor(set, '/a', '', [])).toBeUndefined()
    expect(answerFor(set, '/b', '', [])).toBeUndefined()
  })

  it('removes a redirect', () => {
    const set = setOf()

    set.add('/old', '/new', undefined, rules)

    expect(set.remove('/old')).toBe(true)
    expect(set.remove('/old')).toBe(false)
    expect(answerFor(set, '/old', '', [])).toBeUndefined()
  })
})

describe('a path that is gone', () => {
  it('answers 410 for an exact path and a pattern, with no target', () => {
    const set = setOf()

    expect(set.add('/retired', '', 410, rules)).toMatchObject({ from: '/retired', to: '', status: 410 })
    set.add('/retired-docs/*', 'ignored', 410, rules)

    expect(answerFor(set, '/retired/', '?x=1', [])).toEqual({ location: '', status: 410 })
    expect(answerFor(set, '/retired-docs/a/b', '', [])).toEqual({ location: '', status: 410 })
    expect(set.find('/retired-docs/*')?.to).toBe('')
  })

  it('is edited in place: the same path takes a new target and status', () => {
    const set = setOf()

    set.add('/old', '/a', 307, rules)
    set.add('/old', '/b', 308, rules)
    expect(set.list().map(({ from, to, status }) => [from, to, status])).toEqual([['/old', '/b', 308]])
    set.add('/old', '', 410, rules)
    expect(set.list().map(({ to, status }) => [to, status])).toEqual([['', 410]])
  })

  it('refuses a target that is gone', () => {
    const set = setOf()

    set.add('/retired', '', 410, rules)

    expect(() => set.add('/a', '/retired', undefined, rules)).toThrow(/gone/)
  })

  it('still refuses a path that is not one, and a path of the config', () => {
    const set = setOf()

    expect(() => set.add('//evil.example', '', 410, rules)).toThrow()
    expect(() => set.add('/_kay/x', '', 410, rules)).toThrow()
    expect(() => set.add('/cfg', '', 410, { ...rules, configured: { '/cfg': '/z' } })).toThrow(/kay\.config/)
  })

  it('answers 410 from a served app, under a base, without a location', async () => {
    const served = new Elysia().use(await pages({ root: 'tests/fixtures/routing', prebuilt: false, security: false, base: '/app' }))

    addRuntimeRedirect('/rt-retired', '', { status: 410 })

    const response = await served.handle(new Request('http://localhost/rt-retired'))

    expect([response.status, response.headers.get('location')]).toEqual([410, null])
    expect(missingPaths().map(({ path }) => path)).not.toContain('/rt-retired')
    removeRuntimeRedirect('/rt-retired')
  })
})

describe('what the app tells the screens', () => {
  it('lists the config\'s redirects with their status and the paths the site serves', () => {
    knowRuntimeRules({ redirects: { '/a': '/b', '/c': '/d' }, statuses: { '/c': 301 }, served: () => ['/b', '/d', '/e', '/f.xml'], pages: () => ['/e', '/b', '/b'] })

    expect(configuredRedirects()).toEqual([{ from: '/a', to: '/b', status: 308 }, { from: '/c', to: '/d', status: 301 }])
    expect(sitePaths()).toEqual(['/b', '/e'])
    knowRuntimeRules({ redirects: {} })
    expect(sitePaths()).toEqual([])
  })

  it('follows the pages when they change, and hands out a copy of the sorted answer', () => {
    let pages = ['/b', '/a']

    knowRuntimeRules({ redirects: {}, pages: () => [...pages] })
    expect(sitePaths()).toEqual(['/a', '/b'])
    sitePaths().push('/x')
    expect(sitePaths()).toEqual(['/a', '/b'])
    pages = ['/c', '/b', '/a']
    expect(sitePaths()).toEqual(['/a', '/b', '/c'])
    pages = ['/z']
    expect(sitePaths()).toEqual(['/z'])
    knowRuntimeRules({ redirects: {} })
  })
})

describe('a served app', () => {
  async function app(options: { base?: string, trailingSlash?: 'always' | 'never' | 'ignore', redirects?: Record<string, string>, runtimeRedirects?: { hosts: string[] } } = {}) {
    return new Elysia().use(await pages({ root: 'tests/fixtures/routing', prebuilt: false, security: false, ...options }))
  }

  it('answers a missing path with the redirect, the config\'s status, the query and the base', async () => {
    const served = await app({ base: '/app' })

    expect((await served.handle(new Request('http://localhost/rt-gone'))).status).toBe(404)

    addRuntimeRedirect('/rt-gone', '/bare', { status: 301 })

    const response = await served.handle(new Request('http://localhost/rt-gone/?utm=a'))

    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/app/bare?utm=a')
    expect(missingPaths().map(({ path }) => path)).not.toContain('/rt-gone')

    removeRuntimeRedirect('/rt-gone')
    expect((await served.handle(new Request('http://localhost/rt-gone'))).status).toBe(404)
  })

  it('answers a missing path with the redirect to a client taking compression, whatever the 404 page weighs', async () => {
    const served = new Elysia().use(await pages({ root: 'tests/fixtures/site', prebuilt: false, security: false, compress: true }))

    addRuntimeRedirect('/rt-zipped', '/about')

    try {
      for (const accept of ['gzip', 'br', 'zstd, br, gzip', 'identity']) {
        const response = await served.handle(new Request('http://localhost/rt-zipped', { headers: { 'accept-encoding': accept } }))

        expect([response.status, response.headers.get('location')], accept).toEqual([307, '/about'])
      }
    }
    finally {
      removeRuntimeRedirect('/rt-zipped')
    }
  })

  it('writes a target with a slash under trailingSlash always, and not a file\'s', async () => {
    const served = await app({ trailingSlash: 'always' })

    addRuntimeRedirect('/rt-slash', '/bare/')
    addRuntimeRedirect('/rt-slash2', '/bare')

    expect((await served.handle(new Request('http://localhost/rt-slash/'))).headers.get('location')).toBe('/bare/')
    expect((await served.handle(new Request('http://localhost/rt-slash2/'))).headers.get('location')).toBe('/bare/')
  })

  it('writes the target without its slash under never and as written under ignore', async () => {
    const never = await app({ trailingSlash: 'never' })

    addRuntimeRedirect('/rt-never', '/bare/')
    expect((await never.handle(new Request('http://localhost/rt-never'))).headers.get('location')).toBe('/bare')

    const ignore = await app({ trailingSlash: 'ignore' })

    addRuntimeRedirect('/rt-ignore', '/bare/')
    expect((await ignore.handle(new Request('http://localhost/rt-ignore'))).headers.get('location')).toBe('/bare/')
  })

  it('leaves a page that is served alone, whatever the set holds for its path', async () => {
    const served = await app()

    addRuntimeRedirect('/bare', '/blog')
    expect((await served.handle(new Request('http://localhost/bare'))).status).toBe(200)
    removeRuntimeRedirect('/bare')
  })

  it('answers a path under a locale prefix as the visitor asked for it', async () => {
    const served = new Elysia().use(await pages({ root: 'tests/fixtures/i18n', prebuilt: false, security: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: resolve('tests/fixtures/i18n/src/messages') } }))

    addRuntimeRedirect('/en/rt-loc-old', '/en')
    addRuntimeRedirect('/rt-loc-bare', '/en')

    const prefixed = await served.handle(new Request('http://localhost/en/rt-loc-old'))

    expect([prefixed.status, prefixed.headers.get('location')]).toEqual([307, '/en'])
    expect((await served.handle(new Request('http://localhost/fr/rt-loc-old'))).status).toBe(404)
  })

  it('lets the config\'s redirects win and never touches a page that is served', async () => {
    const served = await app({ redirects: { '/rt-cfg': '/bare' } })

    expect((await served.handle(new Request('http://localhost/rt-cfg'))).headers.get('location')).toBe('/bare')
    expect((await served.handle(new Request('http://localhost/bare'))).status).toBe(200)
    expect(() => addRuntimeRedirect('/rt-cfg', '/bare')).toThrow(/kay\.config/)
  })

  it('refuses a target no page serves, a loop and another site', async () => {
    await app()

    expect(() => addRuntimeRedirect('/rt-x', '/rt-nothing')).toThrow(/nothing on the site serves/)
    expect(() => addRuntimeRedirect('/rt-x', '//evil.example')).toThrow()
    expect(() => addRuntimeRedirect('/rt-x', 'https://evil.example/')).toThrow()
    expect(() => addRuntimeRedirect('/bare', '/bare')).toThrow(/loop/)
    expect(runtimeRedirects().map(row => row.from)).not.toContain('/rt-x')
  })

  it('does not answer a JSON 404, another method nor a path kay counts as a scanner\'s', async () => {
    const served = await app()

    addRuntimeRedirect('/rt-post', '/bare')
    addRuntimeRedirect('/rt-wp/wp-login.php', '/bare')

    expect((await served.handle(new Request('http://localhost/rt-post', { method: 'POST' }))).status).not.toBe(307)
    expect((await served.handle(new Request('http://localhost/rt-wp/wp-login.php'))).status).toBe(404)
  })

  it('allows another host only when the config lists it', async () => {
    const served = await app({ runtimeRedirects: { hosts: ['example.org'] } })

    addRuntimeRedirect('/rt-out', 'https://example.org/page')

    expect((await served.handle(new Request('http://localhost/rt-out'))).headers.get('location')).toBe('https://example.org/page')
    expect(() => addRuntimeRedirect('/rt-out2', 'https://evil.example/')).toThrow()
  })
})

describe('a page that answers 404 itself', () => {
  it('is redirected once under the base, from a dynamic page and from _404.kay', async () => {
    const root = await scratchDir('runtime-redirects-')

    await Bun.write(join(root, 'src/routes/index.kay'), 'main Home\n')
    await Bun.write(join(root, 'src/routes/new.kay'), 'main New\n')
    await Bun.write(join(root, 'src/routes/_404.kay'), 'main Gone\n')
    await Bun.write(join(root, 'src/routes/post/[slug].kay'), '--- server\nif (ctx.params.slug !== \'here\') ctx.notFound()\n---\nmain Here\n')

    const served = new Elysia().use(await pages({ routes: join(root, 'src/routes'), prebuilt: false, security: false, base: '/app' }))

    addRuntimeRedirect('/post/old', '/new')
    addRuntimeRedirect('/nowhere', '/new', { status: 302 })

    const post = await served.handle(new Request('http://localhost/post/old'))
    const fallback = await served.handle(new Request('http://localhost/nowhere'))

    expect([post.status, post.headers.get('location')]).toEqual([307, '/app/new'])
    expect([fallback.status, fallback.headers.get('location')]).toEqual([302, '/app/new'])
    expect((await served.handle(new Request('http://localhost/post/other'))).status).toBe(404)
  })
})

describe('what an editor types', () => {
  it('percent-encodes non-ASCII text, so a header can carry it, and refuses broken characters', () => {
    const set = setOf()

    expect(set.add('/vieux-café', '/café/ça', undefined, rules)).toMatchObject({ from: '/vieux-caf%C3%A9', to: '/caf%C3%A9/%C3%A7a' })
    expect(() => set.add('/a', '/\uD800', undefined, rules)).toThrow()
    expect(answerFor(set, '/vieux-caf%C3%A9', '', [])?.location).toBe('/caf%C3%A9/%C3%A7a')
  })

  it('answers 307 unless the editor picks 308 or another status', () => {
    const set = setOf()

    set.add('/a', '/new', undefined, rules)
    set.add('/b', '/new', 308, rules)

    expect([answerFor(set, '/a', '', [])?.status, answerFor(set, '/b', '', [])?.status]).toEqual([307, 308])
  })

  it('writes the hex of a percent-escape in upper case, as a browser sends it', () => {
    const set = setOf()

    expect(set.add('/caf%c3%a9', '/ok%2f%c3%a9', undefined, rules)).toMatchObject({ from: '/caf%C3%A9', to: '/ok%2F%C3%A9' })
    expect(answerFor(set, '/caf%C3%A9', '', [])?.location).toBe('/ok%2F%C3%A9')
  })

  it('stores the path as a visit is looked up: no query, hash nor trailing slash', () => {
    const set = setOf()

    expect(set.add('/old/', '/new', undefined, rules).from).toBe('/old')
    expect(set.add('/old2?x=1#y', '/new', undefined, rules).from).toBe('/old2')
    expect(answerFor(set, '/old2', '', [])?.location).toBe('/new')
    expect(() => set.add('/cfg/', '/z', undefined, { ...rules, configured: { '/cfg': '/z' } })).toThrow(/kay\.config/)
  })

  it('answers the most specific pattern first', () => {
    const set = setOf()

    set.add('/docs/*', '/guide/*', undefined, rules)
    set.add('/docs/old/*', '/archive/*', undefined, rules)

    expect(answerFor(set, '/docs/old/a', '', [])?.location).toBe('/archive/a')
    expect(answerFor(set, '/docs/new/a', '', [])?.location).toBe('/guide/new/a')
  })
})

describe('the store on disk', () => {
  // The rules of the last app served, none here: any target goes.
  beforeEach(() => {
    knowRuntimeRules({ redirects: {} })
  })

  it('lets a second connection see the first one\'s redirect, so opposite ones from two writers make a loop that is refused', async () => {
    const root = await scratchDir('runtime-redirects-')
    const file = join(root, 'data/not-found.sqlite')

    addRuntimeRedirect('/rt-w-a', '/rt-w-b', { file })

    expect(() => addRuntimeRedirect('/rt-w-b', '/rt-w-a', { file })).toThrow(/loop/)
    expect(runtimeRedirects(file).map(row => row.from)).toEqual(['/rt-w-a'])
  })

  it('answers from memory yet follows what another connection adds or removes, and what its own does', async () => {
    const file = join(await scratchDir('runtime-redirects-'), 'data/not-found.sqlite')
    const [served, editor] = [redirectSet(openSqlite(file)), redirectSet(openSqlite(file))]
    const asked = (path: string) => answerFor(served, path, '', [])?.location

    expect(asked('/rt-m-a')).toBeUndefined()
    editor.add('/rt-m-a', '/new', undefined, rules)
    editor.add('/rt-m/:x', '/dir/:x', undefined, rules)
    expect(asked('/rt-m-a')).toBe('/new')
    expect(asked('/rt-m/b')).toBe('/dir/b')
    editor.remove('/rt-m-a')
    expect(asked('/rt-m-a')).toBeUndefined()
    served.add('/rt-m-c', '/other', undefined, rules)
    expect(asked('/rt-m-c')).toBe('/other')
    served.remove('/rt-m-c')
    expect(asked('/rt-m-c')).toBeUndefined()
  })

  // Root writes through any mode, as in CI.
  it.skipIf(process.getuid?.() === 0)('throws what the store says for a data folder nobody can write, apart from a refusal', async () => {
    const root = await scratchDir('runtime-redirects-')
    const file = join(root, 'data/not-found.sqlite')

    addRuntimeRedirect('/rt-ro', '/rt-ro2', { file })
    await chmod(file, 0o400)
    await chmod(join(root, 'data'), 0o500)

    try {
      let thrown: unknown

      try {
        addRuntimeRedirect('/rt-ro3', '/rt-ro4', { file })
      }
      catch (error) {
        thrown = error
      }

      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).not.toBeInstanceOf(RedirectRefusedError)
    }
    finally {
      await chmod(join(root, 'data'), 0o700)
    }
  })

  it('answers the 404 on, and keeps the store, when a stored target is no header', async () => {
    const root = await scratchDir('runtime-redirects-')
    const file = join(root, 'data/not-found.sqlite')

    dropStore()

    const redirector = missingRedirector({ file })
    const served = redirector.unrouted(redirector.pages(new Elysia())).get('/*', ({ request }) => {
      pageRequested(request)

      return new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } })
    })

    const store = sharedStore(file, true)!

    store.redirects.add('/rt-uni', '/ok', undefined, rules)
    store.redirects.add('/rt-ok', '/rt-fine', undefined, rules)
    // Written by other means, as a file edited by hand or an older kay could leave it.
    const other = openSqlite(file)

    other.run('UPDATE kay_redirects SET target = ? WHERE path = ?', ['/日本', '/rt-uni'])
    other.close()

    expect((await served.handle(new Request('http://localhost/rt-uni'))).status).toBe(404)
    expect((await served.handle(new Request('http://localhost/rt-ok'))).status).toBe(307)
    dropStore()
  })
})
