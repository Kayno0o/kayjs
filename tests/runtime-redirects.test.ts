import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { addRuntimeRedirect, removeRuntimeRedirect, runtimeRedirects } from '../src/server/library'
import { missingPaths } from '../src/server/not-found'
import { answerFor, redirectSet } from '../src/server/runtime-redirects'
import { scratchDir } from './scratch'

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
    expect(answerFor(set, '/go/%2Fevil.example', '', [])?.location).toBe('/%2Fevil.example')
    expect(answerFor(set, '/go/\\evil.example', '', [])).toBeUndefined()
    expect(answerFor(set, '/go/%5Cevil.example', '', [])?.location).toBe('/%5Cevil.example')
    expect(answerFor(set, '/p/%2F%2Fevil.example', '', [])?.location).toBe('/%2F%2Fevil.example')
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

describe('a served app', () => {
  async function app(options: { base?: string, trailingSlash?: 'always' | 'never' | 'ignore', redirects?: Record<string, string>, runtimeRedirects?: { hosts: string[] } } = {}) {
    return new Elysia().use(await pages({ routes: 'tests/fixtures/routing/src/routes', prebuilt: false, security: false, ...options }))
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

  it('writes a target with a slash under trailingSlash always, and not a file\'s', async () => {
    const served = await app({ trailingSlash: 'always' })

    addRuntimeRedirect('/rt-slash', '/bare/')
    addRuntimeRedirect('/rt-slash2', '/bare')

    expect((await served.handle(new Request('http://localhost/rt-slash/'))).headers.get('location')).toBe('/bare/')
    expect((await served.handle(new Request('http://localhost/rt-slash2/'))).headers.get('location')).toBe('/bare/')
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

    expect((await served.handle(new Request('http://localhost/rt-post', { method: 'POST' }))).status).not.toBe(308)
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

    expect([post.status, post.headers.get('location')]).toEqual([308, '/app/new'])
    expect([fallback.status, fallback.headers.get('location')]).toEqual([302, '/app/new'])
    expect((await served.handle(new Request('http://localhost/post/other'))).status).toBe(404)
  })
})
