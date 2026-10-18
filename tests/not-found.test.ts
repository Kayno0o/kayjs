import type { MissingPath } from '../src/server/not-found'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { devNotFound, devRedirect } from '../src/server/dev-not-found'
import { answeredBy, countedPath, countMissing, knowRedirects, missingPaths, missingStore, pageRequested, referrerHost, suggester, unansweredPaths } from '../src/server/not-found'
import { withRedirect } from '../src/server/not-found-config'
import { readRuntimeRedirects } from '../src/server/runtime-redirects'
import { scratchDir } from './scratch'

const known = ['/', '/about', '/blog/hello-world', '/blog/second-post', '/news/launch', '/fr/a-propos', '/fr/blog/hello-world']

// The count is written after the answer went out, so a test waits for what it expects to be listed.
async function counted(path: string): Promise<MissingPath> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = missingPaths().find(row => row.path === path)

    if (found)
      return found

    await Bun.sleep(10)
  }

  throw new Error(`${path} was never counted`)
}

const settings = { defaultLocale: 'en', locales: ['en', 'fr'], prefixDefault: false }

describe('countedPath', () => {
  it('keeps a path without its trailing slash and its query', () => {
    expect(countedPath('/old/')).toBe('/old')
    expect(countedPath('/old//')).toBe('/old')
    expect(countedPath('/')).toBe('/')
    expect(countedPath('/caf%C3%A9')).toBe('/caf%C3%A9')
  })

  it('ignores what scanners ask every site for', () => {
    for (const path of ['/wp-admin/setup.php', '/wp-login', '/blog/wp-content/x', '/.env', '/app/.env.local', '/.git/config', '/index.PHP', '/%2eenv', '/shell.php/x', '/phpmyadmin/', '/cgi-bin/x', '/db.sql', '/x.asp'])
      expect(countedPath(path)).toBeUndefined()

    expect(countedPath('/.well-known/security.txt')).toBe('/.well-known/security.txt')
    expect(countedPath('/envelope')).toBe('/envelope')
    expect(countedPath('/phpfan')).toBe('/phpfan')
    expect(countedPath('/vendor/acme')).toBe('/vendor/acme')
    expect(countedPath('/favicon.ico')).toBeUndefined()
    expect(countedPath('/robots.txt')).toBeUndefined()
  })

  it('ignores hostile input rather than storing it', () => {
    expect(countedPath(`/${'a'.repeat(600)}`)).toBeUndefined()
    expect(countedPath('/%E0%A4%A')).toBeUndefined()
    expect(countedPath('/a%00b')).toBeUndefined()
    expect(countedPath('/a%0Ab')).toBeUndefined()
    expect(countedPath('/_kay/island/x')).toBeUndefined()
    expect(countedPath('//evil.example')).toBe('//evil.example')
  })
})

describe('referrerHost', () => {
  it('keeps the host alone', () => {
    expect(referrerHost('https://Search.Example/results?q=secret#x')).toBe('search.example')
    expect(referrerHost('http://localhost:3000/a')).toBe('localhost:3000')
  })

  it('drops what is no web address or too long', () => {
    expect(referrerHost(null)).toBeUndefined()
    expect(referrerHost('android-app://com.google/')).toBeUndefined()
    expect(referrerHost('not a url')).toBeUndefined()
    expect(referrerHost(`https://${'a'.repeat(300)}.example/`)).toBeUndefined()
    expect(referrerHost(`https://x.example/${'a'.repeat(3000)}`)).toBeUndefined()
  })
})

describe('suggester', () => {
  const suggest = suggester(known, settings)

  it('finds the same page spelled another way', () => {
    expect(suggest('/About')).toEqual({ target: '/about', reason: 'spelling' })
    expect(suggest('/about.html')).toEqual({ target: '/about', reason: 'spelling' })
    expect(suggest('/blog/Hello-World')).toEqual({ target: '/blog/hello-world', reason: 'spelling' })
  })

  it('finds the page in another locale', () => {
    expect(suggest('/fr/about')).toEqual({ target: '/about', reason: 'locale' })
    expect(suggester(['/', '/fr/contact'], settings)('/contact')).toEqual({ target: '/fr/contact', reason: 'locale' })
    expect(suggester(['/contact', '/fr/contact'], settings)('/de/contact')).toBeUndefined()
  })

  it('finds a slug moved under another parent, when only one page has it', () => {
    expect(suggest('/articles/launch')).toEqual({ target: '/news/launch', reason: 'slug' })
    expect(suggest('/articles/hello-world')).toBeUndefined()
    expect(suggest('/blog/hello-world/')).toBeUndefined()
    expect(suggest('/fr/archive/hello-world')).toEqual({ target: '/fr/blog/hello-world', reason: 'slug' })
  })

  it('finds a near typo of a slug, when one page is closest', () => {
    expect(suggest('/blog/secnd-post')).toEqual({ target: '/blog/second-post', reason: 'similar' })
    expect(suggest('/blog/zzzzzzzz')).toBeUndefined()
    expect(suggester(['/a/abcdef', '/a/abcdeg'], settings)('/a/abcdeh')).toBeUndefined()
  })

  it('suggests nothing for the root, an empty site or a path that exists', () => {
    expect(suggest('/')).toBeUndefined()
    expect(suggester([])('/x')).toBeUndefined()
    expect(suggest('/about')).toBeUndefined()
  })

  it('stays bounded when asked for many near misses', () => {
    const many = suggester(Array.from({ length: 5000 }, (_, index) => `/p/item-${index}`))
    const start = performance.now()

    for (let index = 0; index < 200; index++)
      many(`/p/itm-${index}x`)

    expect(performance.now() - start).toBeLessThan(2000)
  })
})

describe('missingStore', () => {
  const never = () => undefined

  it('counts hits and referrer hosts, most hit first', async () => {
    const store = missingStore(join(await scratchDir('not-found-'), 'missing.sqlite'))

    store.hit('/a', 'x.example', never)
    store.hit('/b', undefined, never)
    store.hit('/b', 'x.example', never)
    store.hit('/b', 'x.example', never)
    expect(store.list().map(({ path, hits, referrers }) => ({ path, hits, referrers }))).toEqual([{ path: '/b', hits: 3, referrers: [{ host: 'x.example', hits: 2 }] }, { path: '/a', hits: 1, referrers: [{ host: 'x.example', hits: 1 }] }])
    store.close()
  })

  it('keeps its counts across restarts', async () => {
    const file = join(await scratchDir('not-found-'), 'missing.sqlite')
    const first = missingStore(file)

    first.hit('/a', 'x.example', never)
    first.close()

    const second = missingStore(file)

    second.hit('/a', undefined, never)
    expect(second.list()).toMatchObject([{ path: '/a', hits: 2 }])
    second.close()
  })

  it('suggests once, when a path is asked for the second time', async () => {
    const store = missingStore(join(await scratchDir('not-found-'), 'missing.sqlite'))
    let asked = 0
    const suggest = () => {
      asked++

      return { target: '/new', reason: 'slug' as const }
    }

    store.hit('/old', undefined, suggest)
    expect(asked).toBe(0)
    store.hit('/old', undefined, suggest)
    store.hit('/old', undefined, suggest)
    expect(asked).toBe(1)
    expect(store.list()[0]).toMatchObject({ target: '/new', reason: 'slug' })
    store.close()
  })

  it('stays bounded under a flood of distinct paths, keeping the paths hit again', async () => {
    const store = missingStore(join(await scratchDir('not-found-'), 'missing.sqlite'))

    for (let index = 0; index < 3; index++)
      store.hit('/popular', 'x.example', never)

    for (let index = 0; index < 1500; index++)
      store.hit(`/junk-${index}`, `h${index}.example`, never)

    const listed = store.list()

    expect(listed.length).toBe(1000)
    expect(listed[0]).toMatchObject({ path: '/popular', hits: 3 })
    expect(listed.flatMap(({ referrers }) => referrers).length).toBeLessThanOrEqual(1001)
    store.close()
  })

  it('keeps a few referrer hosts per path', async () => {
    const store = missingStore(join(await scratchDir('not-found-'), 'missing.sqlite'))

    for (let index = 0; index < 30; index++)
      store.hit('/a', `h${index}.example`, never)

    store.hit('/a', 'h0.example', never)
    expect(store.list()[0]!.referrers.length).toBe(8)
    expect(store.list()[0]!.referrers[0]).toEqual({ host: 'h0.example', hits: 2 })
    store.close()
  })

  it('forgets a path with its hosts', async () => {
    const store = missingStore(join(await scratchDir('not-found-'), 'missing.sqlite'))

    store.hit('/a', 'x.example', never)
    store.forget('/a')
    expect(store.list()).toEqual([])
    store.close()
  })
})

describe('answeredBy', () => {
  it('reads a :param as a segment and a final * as the rest, an exact path as itself alone', () => {
    const answered = answeredBy(['/old', '/blog/:slug', '/docs/*', '/a.b'])

    expect(['/old', '/blog/x', '/docs', '/docs/a/b', '/a.b'].map(answered)).toEqual([true, true, true, true, true])
    expect(['/old/x', '/blog', '/blog/x/y', '/docsx', '/axb', '/'].map(answered)).toEqual([false, false, false, false, false, false])
    expect(answeredBy([])('/old')).toBe(false)
  })
})

describe('unansweredPaths', () => {
  it('lists a file\'s paths most hit first, those a redirect answers left out, and creates no file', async () => {
    const dir = await scratchDir('not-found-')
    const file = join(dir, 'missing.sqlite')

    expect(unansweredPaths(file)).toEqual([])
    expect(await Bun.file(file).exists()).toBe(false)

    const store = missingStore(file)

    for (const path of ['/gone', '/gone', '/moved/x', '/blog/old', '/blog/old', '/blog/old'])
      store.hit(path, 'search.example', () => undefined)

    store.close()
    knowRedirects(['/moved/*'])

    try {
      expect(unansweredPaths(file).map(({ path, hits }) => [path, hits])).toEqual([['/blog/old', 3], ['/gone', 2]])
      knowRedirects(['/blog/:slug', '/gone'])
      expect(unansweredPaths(file).map(({ path }) => path)).toEqual(['/moved/x'])
    }
    finally {
      knowRedirects([])
    }
  })
})

describe('countMissing', () => {
  const served = countMissing(new Elysia(), { known: () => ['/fine', '/news/gone2'] })
    .get('/gone', ({ request }) => {
      pageRequested(request)

      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } })
    })
    .get('/api/user', () => Response.json({ error: 'none' }, { status: 404 }))
    .get('/fine', () => 'ok')
    .post('/gone', () => new Response('Not Found', { status: 404 }))

  async function visit(path: string, init: RequestInit = {}) {
    return served.handle(new Request(`http://localhost${path}`, init))
  }

  it('counts GET pages answering 404 with the referrer host, not JSON, other methods, other statuses nor scanners', async () => {
    await visit('/gone?utm=secret#frag', { headers: { referer: 'https://search.example/path?q=private' } })
    await visit('/gone/')
    await visit('/gone', { method: 'POST' })
    await visit('/api/user')
    await visit('/fine')
    await visit('/wp-login.php')
    await visit('/nothing-registered')

    await counted('/nothing-registered')

    // Other files of the same run count into the same store.
    const listed = missingPaths().filter(({ path }) => ['/gone', '/fine', '/api/user', '/wp-login.php', '/nothing-registered'].includes(path))

    expect(listed.map(({ path, hits }) => [path, hits]).sort()).toEqual([['/gone', 2], ['/nothing-registered', 1]])
    expect(listed.find(({ path }) => path === '/gone')!.referrers).toEqual([{ host: 'search.example', hits: 1 }])
    expect(JSON.stringify(listed)).not.toContain('private')
  })
})

describe('a served app', () => {
  it('counts its own 404s in production, under a base and with a trailing slash setting', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/routing/src/routes', prebuilt: false, security: false, base: '/app', trailingSlash: 'always' }))
    const response = await app.handle(new Request('http://localhost/missing-page-x/', { headers: { referer: 'https://elsewhere.example/' } }))

    expect(response.status).toBe(404)
    expect((await counted('/missing-page-x')).referrers).toEqual([{ host: 'elsewhere.example', hits: 1 }])
  })

  it('counts a path under a locale prefix and one with dot segments as the visitor asked for it', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/i18n/src/routes', prebuilt: false, security: false, i18n: { locales: ['fr', 'en'], defaultLocale: 'fr', messages: 'tests/fixtures/i18n/src/messages' } }))

    expect((await app.handle(new Request('http://localhost/en/page-nobody-has-y'))).status).toBe(404)
    await app.handle(new Request('http://localhost/a/../page-nobody-has-z'))
    expect((await counted('/en/page-nobody-has-y')).hits).toBe(1)
    await counted('/page-nobody-has-z')
    expect(missingPaths().filter(({ path }) => path.includes('..'))).toEqual([])
  })

  it('records nothing in development, where only production counts', async () => {
    const dev = new Elysia().use(await pages({ routes: 'tests/fixtures/routing/src/routes', prebuilt: false, security: false, dev: true }))
    const production = new Elysia().use(await pages({ routes: 'tests/fixtures/routing/src/routes', prebuilt: false, security: false }))

    await dev.handle(new Request('http://localhost/page-only-dev-sees'))
    await production.handle(new Request('http://localhost/page-only-production-sees'))
    await counted('/page-only-production-sees')
    expect(missingPaths().map(({ path }) => path)).not.toContain('/page-only-dev-sees')
  })

  it('records nothing while a static export reads the site', async () => {
    const root = await scratchDir('not-found-static-')

    await Bun.write(join(root, 'src/routes/index.kay'), 'main Home\n')
    await Bun.write(join(root, 'src/routes/_404.kay'), 'main Gone\n')
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check', '--static', '--outdir', join(root, 'out')], { env: { PATH: process.env.PATH!, NODE_ENV: 'production' }, stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect({ code, errors }).toMatchObject({ code: 0 })
    expect(existsSync(join(root, 'data/not-found.sqlite'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'data/not-found.sqlite'))).toBe(false)
  })
})

describe('answeredBy', () => {
  it('reads a star outside a trailing /* as a character, not a pattern', () => {
    expect(answeredBy(['*foo', '/x*', '/b/:id', '/docs/*'])('/a')).toBe(false)
    expect(answeredBy(['/x*'])('/x*')).toBe(true)
    expect(answeredBy(['/b/:id'])('/b/7')).toBe(true)
    expect(answeredBy(['/docs/*'])('/docs/a/b')).toBe(true)
  })
})

describe('withRedirect', () => {
  it('adds to the redirects the config has, first', () => {
    expect(withRedirect('export default defineConfig({\n  redirects: {\n    \'/a\': \'/b\',\n  },\n})\n', '/old', '/new')).toBe('export default defineConfig({\n  redirects: {\n    \'/old\': \'/new\',\n    \'/a\': \'/b\',\n  },\n})\n')
  })

  it('fills an empty redirects object', () => {
    expect(withRedirect('export default defineConfig({\n  redirects: {},\n})\n', '/old', '/new')).toBe('export default defineConfig({\n  redirects: {\n    \'/old\': \'/new\',\n  },\n})\n')
  })

  it('opens redirects in the config object', () => {
    expect(withRedirect('export default defineConfig({\n  base: \'/x\',\n})\n', '/old', '/new')).toBe('export default defineConfig({\n  redirects: {\n    \'/old\': \'/new\',\n  },\n  base: \'/x\',\n})\n')
    expect(withRedirect('export default { favicon: false }\n', '/o', '/n')).toBe('export default {\n  redirects: {\n    \'/o\': \'/n\',\n  },\nfavicon: false }\n')
  })

  it('escapes quotes and leaves a config it cannot read alone', () => {
    expect(withRedirect('export default defineConfig({\n})\n', '/it\'s', '/n')).toContain('\'/it\\\'s\': \'/n\'')
    expect(withRedirect('const redirects = {}\nexport default defineConfig({ redirects })\n', '/o', '/n')).toBeUndefined()
    expect(withRedirect('export default defineConfig({\n  name: \'redirects\',\n})\n', '/o', '/n')).toContain('\n  redirects: {\n    \'/o\': \'/n\',\n  },')
    expect(withRedirect('export default makeConfig()\n', '/o', '/n')).toBeUndefined()
  })
})

describe('kay not-found', () => {
  const cli = join(import.meta.dir, '../src/cli.ts')

  async function run(args: string[], cwd: string) {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { stdout, stderr, code }
  }

  async function project(): Promise<string> {
    const root = await scratchDir('not-found-cli-')
    const store = missingStore(join(root, 'data/not-found.sqlite'))

    await Bun.write(join(root, 'kay.config.ts'), 'export default {\n  favicon: false,\n  redirects: { \'/done\': \'/about\' },\n}\n')

    for (const [path, hits, host] of [['/old', 3, 'a.example'], ['/other', 1, undefined], ['/done', 9, undefined]] as const) {
      for (let index = 0; index < hits; index++)
        store.hit(path, host, () => path === '/old' ? { target: '/new', reason: 'slug' } : undefined)
    }

    store.close()

    return root
  }

  it('lists the paths most hit first, leaving out those a redirect answers already', async () => {
    const { stdout, code } = await run(['not-found'], await project())

    expect(code).toBe(0)
    expect(stdout).toContain('/old  (from a.example)')
    expect(stdout).toContain('-> /new  (slug) kay not-found --redirect /old')
    expect(stdout.indexOf('/old')).toBeLessThan(stdout.indexOf('/other'))
    expect(stdout).not.toContain('/done')
  })

  it('prints JSON', async () => {
    const { stdout } = await run(['not-found', '--format', 'json'], await project())

    expect((JSON.parse(stdout) as { missing: { path: string }[] }).missing.map(row => row.path)).toEqual(['/old', '/other'])
  })

  it('says so when nothing was recorded', async () => {
    const root = await scratchDir('not-found-cli-')

    await Bun.write(join(root, 'kay.config.ts'), 'export default { favicon: false }\n')
    expect((await run(['not-found'], root)).stdout).toContain('No missing path recorded')
  })

  it('writes the suggested redirect into kay.config.ts and forgets the path', async () => {
    const root = await project()
    const { stdout, code } = await run(['not-found', '--redirect', '/old'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('\'/old\': \'/new\',')
    expect(await Bun.file(join(root, 'kay.config.ts')).text()).toContain('redirects: {\n    \'/old\': \'/new\',')
    expect((await run(['not-found', '--format', 'json'], root)).stdout).not.toContain('"/old"')
  })

  it('with --runtime writes the redirect to the file the site reads, leaves kay.config.ts alone, and refuses what leaves the site', async () => {
    const root = await project()
    const config = await Bun.file(join(root, 'kay.config.ts')).text()
    const { stdout, code } = await run(['not-found', '--redirect', '/old', '--runtime'], root)

    expect(code).toBe(0)
    expect(stdout).toContain('/old -> /new')
    expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config)
    expect(readRuntimeRedirects(join(root, 'data/not-found.sqlite')).map(({ from, to }) => [from, to])).toEqual([['/old', '/new']])
    expect((await run(['not-found', '--format', 'json'], root)).stdout).not.toContain('"/old"')

    for (const to of ['//evil.example', 'https://evil.example/', '/\\evil.example'])
      expect((await run(['not-found', '--redirect', '/other', '--to', to, '--runtime'], root)).code).toBe(1)

    expect((await run(['not-found', '--redirect', '/done', '--to', '/x', '--runtime'], root)).stderr).toContain('kay.config.ts')
    expect((await run(['not-found', '--runtime'], root)).code).toBe(1)
    expect(readRuntimeRedirects(join(root, 'data/not-found.sqlite'))).toHaveLength(1)
  })

  it('quotes a hostile path in the hint it prints, and leaves out what a pattern redirect answers', async () => {
    const root = await scratchDir('not-found-cli-')
    const store = missingStore(join(root, 'data/not-found.sqlite'))
    const hostile = '/x;$(id)|y&z\'q'

    for (const path of [hostile, hostile, '/old/thing', '/legacy/a/b', '/other'])
      store.hit(path, undefined, () => ({ target: '/blog', reason: 'slug' }))

    store.close()
    await Bun.write(join(root, 'kay.config.ts'), 'export default { favicon: false, redirects: { \'/old/:id\': \'/new/:id\', \'/legacy/*\': \'/x/*\' } }\n')

    const { stdout } = await run(['not-found'], root)

    expect(stdout).toContain('--redirect \'/x;$(id)|y&z\'\\\'\'q\'')
    expect(stdout).not.toContain('/old/thing')
    expect(stdout).not.toContain('/legacy/a/b')
    expect(stdout).toContain('/other')
  })

  it('needs a target when none is suggested, and refuses a bad one or a redirect that exists', async () => {
    const root = await project()

    expect((await run(['not-found', '--redirect', '/other'], root)).stderr).toContain('/other has no suggested target')
    expect((await run(['not-found', '--redirect', '/other', '--to', 'about'], root)).code).toBe(1)
    expect((await run(['not-found', '--redirect', '/done', '--to', '/x'], root)).stderr).toContain('is a redirect already')
    expect((await run(['not-found', '--to', '/x'], root)).code).toBe(1)
    expect(await Bun.file(join(root, 'kay.config.ts')).text()).not.toContain('/other')
  })

  it('adds a redirect to a path nobody recorded, given its target', async () => {
    const root = await scratchDir('not-found-cli-')

    await Bun.write(join(root, 'kay.config.ts'), 'export default { favicon: false }\n')
    expect((await run(['not-found', '--redirect', '/legacy/x', '--to', '/blog/x'], root)).code).toBe(0)
    expect(await Bun.file(join(root, 'kay.config.ts')).text()).toContain('\'/legacy/x\': \'/blog/x\'')
  })
})

describe('routes the counter must not reach', () => {
  it('leaves the 404s of routes registered after the pages alone, whatever they answer with', async () => {
    const app = new Elysia().use(await pages({ routes: 'tests/fixtures/routing/src/routes', prebuilt: false, security: false })).get('/api/users/42', ({ status }) => status(404, { error: 'none' })).get('/api/set/9', ({ set }) => {
      set.status = 404

      return { error: 'none' }
    }).get('/api/text/7', () => new Response('none', { status: 404, headers: { 'content-type': 'text/plain' } }))

    for (const path of ['/api/users/42', '/api/set/9', '/api/text/7', '/page-nobody-has-x'])
      await app.handle(new Request(`http://localhost${path}`))

    await counted('/page-nobody-has-x')

    const paths = missingPaths().map(({ path }) => path)

    expect(paths).toContain('/page-nobody-has-x')
    expect(paths.filter(path => path.startsWith('/api/'))).toEqual([])
  })
})

describe('withRedirect in a config that tempts it', () => {
  it('skips comments, strings and nested keys, and gives up on a redirects that is no literal', () => {
    const commented = 'export default defineConfig({\n  // redirects: { }\n  i18n: { redirects: {} },\n  note: \'redirects: {\',\n})\n'
    const added = withRedirect(commented, '/o', '/n')!

    expect(added).toContain('\n  redirects: {\n    \'/o\': \'/n\',\n  },\n  // redirects: { }')
    expect(added.indexOf('\'/o\'')).toBeLessThan(added.indexOf('i18n'))
    expect(withRedirect('export default defineConfig({\n  redirects,\n})\n', '/o', '/n')).toBeUndefined()
    expect(withRedirect('export default defineConfig({\n  redirects: shared,\n})\n', '/o', '/n')).toBeUndefined()
    expect(withRedirect('export default defineConfig({\n  \'redirects\': {\n    \'/a\': \'/b\',\n  },\n})\n', '/o', '/n')).toContain('\'redirects\': {\n    \'/o\': \'/n\',')
  })

  it('finds a quoted redirects key far from its colon', () => {
    const gap = `${' '.repeat(80)}// the old paths\n  /* and more */ `
    const added = withRedirect(`export default defineConfig({\n  'redirects'${gap}: {\n    '/a': '/b',\n  },\n})\n`, '/o', '/n')!

    expect(added).toContain(`: {\n    '/o': '/n',\n    '/a': '/b',`)
    expect(added.match(/redirects/g)).toHaveLength(1)
  })
})

describe('suggestions under trailingSlash always', () => {
  it('keep the slash the site spells its paths with', async () => {
    const app = countMissing(new Elysia(), { known: () => ['/about/'], trailingSlash: 'always' })
      .get('/*', ({ request }) => {
        pageRequested(request)

        return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/html' } })
      })

    for (let index = 0; index < 2; index++)
      await app.handle(new Request('http://localhost/About-Us-x/'))

    for (let index = 0; index < 2; index++)
      await app.handle(new Request('http://localhost/ABOUT/'))

    expect((await counted('/ABOUT')).target).toBe('/about/')
  })
})

describe('the dev tool tab', () => {
  async function recorded(redirects = 'redirects: { \'/done\': \'/about\' },\n  '): Promise<string> {
    const root = await scratchDir('not-found-dev-')
    const store = missingStore(join(root, 'data/not-found.sqlite'), false)

    await Bun.write(join(root, 'kay.config.ts'), `export default {\n  ${redirects}favicon: false,\n}\n`)

    for (const [path, hits, host] of [['/old', 3, 'a.example'], ['/other', 1, undefined], ['/done', 9, undefined]] as const) {
      for (let index = 0; index < hits; index++)
        store.hit(path, host, () => path === '/old' ? { target: '/new', reason: 'slug' } : undefined)
    }

    store.close()

    return root
  }

  const post = (body: unknown, headers: Record<string, string> = { 'x-kay-dev': '1' }) => new Request('http://localhost/_kay/dev/not-found', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  it('lists the recorded paths most hit first, without those a redirect answers', async () => {
    const listed = devNotFound(await recorded(), ['/done'])

    expect(listed.recorded).toBe(true)
    expect(listed.missing.map(row => [row.path, row.hits, row.target, row.referrers])).toEqual([['/old', 3, '/new', [{ host: 'a.example', hits: 3 }]], ['/other', 1, undefined, []]])
  })

  it('says there is no file when production left none', async () => {
    expect(devNotFound(await scratchDir('not-found-dev-'), [])).toEqual({ file: 'data/not-found.sqlite', recorded: false, missing: [] })
  })

  it('writes the suggested redirect, or the one named, and forgets the path', async () => {
    const root = await recorded()
    const suggested = await devRedirect(root, post({ path: '/old' }), ['/done'])

    expect(await suggested.json()).toEqual({ redirect: { from: '/old', to: '/new' } })
    expect(await Bun.file(join(root, 'kay.config.ts')).text()).toContain('redirects: {\n    \'/old\': \'/new\',')
    expect(devNotFound(root, ['/done']).missing.map(row => row.path)).toEqual(['/other'])

    const named = await devRedirect(root, post({ path: '/other', to: 'https://example.com/x' }), ['/done', '/old'])

    expect(await named.json()).toEqual({ redirect: { from: '/other', to: 'https://example.com/x' } })
    expect(devNotFound(root, []).missing.map(row => row.path)).toEqual(['/done'])
  })

  it('refuses a request without the dev header, a cross-site one, a missing target, a bad target and a redirect that exists', async () => {
    const root = await recorded()
    const config = await Bun.file(join(root, 'kay.config.ts')).text()

    expect((await devRedirect(root, post({ path: '/old' }, {}), [])).status).toBe(403)
    expect((await devRedirect(root, post({ path: '/old' }, { 'x-kay-dev': '1', 'sec-fetch-site': 'cross-site' }), [])).status).toBe(403)

    for (const [body, redirects, message] of [
      [{ path: '/other' }, [], 'no suggested target'],
      [{ path: '/other', to: 'javascript:alert(1)' }, [], 'is no target'],
      [{ path: '/other', to: '/x\n' }, [], 'control character'],
      [{ path: '/old' }, ['/old'], 'is a redirect already'],
      [{ path: 3 }, [], 'texts'],
    ] as const) {
      const response = await devRedirect(root, post(body), [...redirects])

      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain(message)
    }

    expect(await Bun.file(join(root, 'kay.config.ts')).text()).toBe(config)
  })

  it('tells when the config has no redirects object to write into', async () => {
    const root = await recorded()

    await Bun.write(join(root, 'kay.config.ts'), 'export default makeConfig()\n')
    expect(((await (await devRedirect(root, post({ path: '/old' }), [])).json()) as { error: string }).error).toContain('add it by hand')
  })

  it('is served by a dev server alone', async () => {
    const root = await recorded()
    const script = join(root, 'serve.ts')

    await Promise.all([
      Bun.write(join(root, 'src/routes/index.kay'), 'h1 Home\n'),
      Bun.write(script, `import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}\n\nconst ask = async (app: { handle: (request: Request) => Promise<Response> }, method: string) => {\n  const response = await app.handle(new Request('http://localhost/_kay/dev/not-found', { method, headers: { 'x-kay-dev': '1', 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ path: '/old' }) : undefined }))\n\n  return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : undefined }\n}\nconst dev = await pages({ root: process.cwd(), prebuilt: false, security: false, dev: true, redirects: { '/done': '/about' } })\nconst listed = await ask(dev, 'GET')\nconst added = await ask(dev, 'POST')\nconst served = await pages({ root: process.cwd(), prebuilt: false, security: false })\n\nconsole.log(JSON.stringify({ listed, added, served: (await ask(served, 'GET')).status }))\nprocess.exit(0)\n`),
    ])

    const child = Bun.spawn([process.execPath, script], { cwd: root, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const result = JSON.parse(stdout.trim().split('\n').at(-1)!) as { listed: { body: { missing: { path: string }[] } }, added: { status: number }, served: number }

    expect(stderr).not.toContain('error')
    expect(result.listed.body.missing.map(row => row.path)).toEqual(['/old', '/other'])
    expect(result.added.status).toBe(200)
    expect(result.served).toBe(404)
  })
})
