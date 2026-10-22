import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { bootProblems } from '../src/check/boot'
import { contentChecks, projectProblems } from '../src/check/project'
import { collection, entries, entryPage, paginate } from '../src/content'
import { unservedRoutes } from '../src/content/claims'
import { registerCollections, registerEditSite } from '../src/content/edit'
import { feedXml } from '../src/content/feed'
import { localizedLink } from '../src/runtime/i18n'
import { alternate } from '../src/runtime/i18n.server'
import { runInLocale } from '../src/runtime/locale-state'
import { linkedSettings } from '../src/server/i18n'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const config = (trailingSlash: string) => `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ log: false, site: 'https://x.example', base: '/site', trailingSlash: '${trailingSlash}', i18n: { locales: ['en', 'fr'], defaultLocale: 'en', paths: { '/notes/:slug': { fr: '/remarques/:slug' } } } })\n`
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const MESSAGES = 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n'
const FILES: Record<string, string> = {
  'src/messages/en.ts': MESSAGES,
  'src/messages/fr.ts': MESSAGES,
  'src/content.config.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const notes = collection(\'content/notes\', { schema: s.Object({ title: s.String(), date: s.Date() }), localized: true, route: \'/notes/:slug\', feed: { path: \'/feeds/notes.xml\', title: \'Notes\', item: note => ({ title: note.data.title, date: note.data.date }) } })\n',
  'src/content/notes/en/a.md': '---\ntitle: first\ndate: 2026-01-01\n---\nbody\n',
  'src/content/notes/fr/a.md': '---\ntitle: premier\ndate: 2026-01-01\n---\ncorps\n',
  'src/routes/notes/[slug].kay': '--- server\nimport { notes } from \'../../content.config\'\n\nexport const page = { prerender: notes }\n\nconst note = await notes.get(ctx.params.slug) ?? ctx.notFound()\n---\nh1 {note.data.title}\na.self(href={note.url}) self\n',
}

const schema = t.Object({ title: t.String() })
const item = (title: string) => ({ title, date: new Date('2026-01-01') })

describe('a collection route', () => {
  it('gives each entry the path of its page, encoded', async () => {
    const posts = collection({ name: 'route-encoded', load: () => [{ slug: 'hello', data: { title: 'Hello' } }, { slug: 'a b?c', data: { title: 'Odd' } }] }, { schema, route: '/blog/:slug' })
    const entries = await posts.all()

    expect(entries.map(entry => entry.url)).toEqual(['/blog/a%20b%3Fc', '/blog/hello'])
    expect((await posts.get('hello'))?.url).toBe('/blog/hello')
  })

  it('keeps the folders of a slug under a catch-all route', async () => {
    const docs = collection({ name: 'route-folders', load: () => [{ slug: 'guides/intro', data: { title: 'Intro' } }] }, { schema, route: '/docs/*slug' })

    expect((await docs.all()).map(entry => entry.url)).toEqual(['/docs/guides/intro'])
  })

  it('sets no url without a route', async () => {
    const posts = collection({ name: 'route-none', load: () => [{ slug: 'hello', data: { title: 'Hello' } }] }, { schema })

    expect((await posts.all())[0]?.url).toBeUndefined()
  })

  it('gives each locale\'s entry the url of its own slug', async () => {
    const posts = collection({ name: 'route-locales', load: () => [{ slug: 'en/hello', data: { title: 'Hello' } }, { slug: 'fr/bonjour', data: { title: 'Bonjour' } }] }, { schema, localized: true, route: '/blog/:slug' })

    expect((await posts.all()).map(entry => `${entry.locale}:${entry.url}`)).toEqual(['fr:/blog/bonjour', 'en:/blog/hello'])
  })

  it.each(['blog/:slug', '/blog/:id', '/blog/:slug/:page', '/blog/:slug?', '/blog'])('refuses the route %s', (route) => {
    expect(() => collection({ name: 'route-bad', load: () => [] }, { schema, route })).toThrow('route')
  })

  it('is the path of a feed item that sets none, as a hand-written one is linked', async () => {
    const posts = collection({ name: 'route-feed', load: () => [{ slug: 'hello', data: { title: 'Hello' } }] }, { schema, route: '/blog/:slug' })
    const entries = await posts.all()
    const feed = { path: '/blog/rss.xml', title: 'Blog', item: (entry: { data: { title: string } }) => item(entry.data.title) }

    for (const trailingSlash of ['never', 'always'] as const)
      expect(feedXml(entries, feed, 'https://x.example/site', '/', trailingSlash)).toContain(`<link>https://x.example/site/blog/hello${trailingSlash === 'always' ? '/' : ''}</link>`)
  })

  it('makes a feed item without a path or a route fail, naming the entry', async () => {
    const posts = collection({ name: 'route-feed-none', load: () => [{ slug: 'hello', data: { title: 'Hello' } }] }, { schema })
    const feed = { path: '/rss.xml', title: 'Blog', item: (entry: { data: { title: string } }) => item(entry.data.title) }

    const entries = await posts.all()

    expect(() => feedXml(entries, feed, 'https://x.example')).toThrow('no `path`')
  })
})

describe('the types of a collection route', () => {
  it('types url as a string for a routed collection and a page of it, and a feed path as required without one', async () => {
    const routed = collection({ name: 'route-types', load: () => [{ slug: 'hello', data: { title: 'Hello' } }] }, { schema, route: '/blog/:slug', feed: { path: '/rss.xml', title: 'T', item: entry => item(entry.data.title) } })
    const plain = collection({ name: 'route-types-plain', load: () => [{ slug: 'hello', data: { title: 'Hello' } }] }, { schema, feed: { path: '/rss.xml', title: 'T', item: entry => ({ ...item(entry.data.title), path: `/${entry.slug}` }) } })

    // @ts-expect-error a feed with no route says where its items link
    collection({ name: 'route-types-bare', load: () => [] }, { schema, feed: { path: '/rss.xml', title: 'T', item: entry => item(entry.data.title) } })

    const first: string = (await routed.all())[0]!.url
    // A page of a paginated list runs only while a page renders: it is typed here, not called.
    const paged = async (): Promise<string> => (await paginate(routed, 5).page(undefined))!.items[0]!.url
    // @ts-expect-error without a route the url may be missing
    const missing: string = (await plain.all())[0]!.url

    expect([first, missing as string | undefined, typeof paged]).toEqual(['/blog/hello', undefined, 'function'])
  })
})

describe('unservedRoutes', () => {
  const routes = [{ collection: 'posts', route: '/blog/:slug' }, { collection: 'docs', route: '/docs/*slug' }]

  it('keeps a route no page pattern matches, whatever the param is named', () => {
    expect(unservedRoutes(routes, ['/blog/:id', '/docs/*'])).toEqual([])
    expect(unservedRoutes(routes, ['/blog', '/docs/:slug'])).toEqual(routes)
    expect(unservedRoutes(routes, ['/blog/:slug'])).toEqual([routes[1]!])
    expect(unservedRoutes(routes, ['/*'])).toEqual([])
    expect(unservedRoutes(routes, ['/blog/*', '/docs/:slug'])).toEqual([routes[1]!])
  })
})

describe('kay check', () => {
  it('reads the routes of the collections in the project and reports the unserved one', async () => {
    const root = await scratchDir('collection-route-probe-')

    try {
      await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': config('never'), ...FILES, 'src/routes/other.kay': 'h1 Other\n' }).map(async ([path, content]) => Bun.write(join(root, path), content)))
      await rm(join(root, 'src/routes/notes'), { recursive: true, force: true })

      const options = { site: 'https://x.example' }
      const content = await contentChecks(root, options)

      expect(content.routes).toEqual([{ collection: 'notes', route: '/notes/:slug' }])
      expect((await projectProblems(root, options, content)).map(problem => problem.message)).toEqual([expect.stringContaining('the route /notes/:slug of the collection notes is served by no page')])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('reports a page prerendering a routed collection while another page serves its route', async () => {
    const root = await scratchDir('collection-route-prerender-')

    try {
      const prerendering = '--- server\nexport const page = { prerender: posts }\n---\nh1 Post\n'

      await Bun.write(join(root, 'src/routes/blog/[slug].kay'), 'h1 Post\n')
      await Bun.write(join(root, 'src/routes/posts/[slug].kay'), prerendering)

      const routes = [{ collection: 'posts', route: '/blog/:slug' }]
      const problems = (await bootProblems(root, {}, [], undefined, routes)).map(problem => problem.message)

      expect(problems).toEqual([expect.stringContaining('this page prerenders the collection posts')])

      await Bun.write(join(root, 'src/routes/blog/[slug].kay'), prerendering)
      await rm(join(root, 'src/routes/posts'), { recursive: true, force: true })
      expect(await bootProblems(root, {}, [], undefined, routes)).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a route no page serves, and none when a page does', async () => {
    const root = await scratchDir('collection-route-check-')

    try {
      await Bun.write(join(root, 'src/routes/blog/[id].kay'), 'h1 Post\n')
      await Bun.write(join(root, 'src/routes/docs/[...slug].kay'), 'h1 Doc\n')

      const routes = [{ collection: 'posts', route: '/blog/:slug' }, { collection: 'docs', route: '/docs/*slug' }, { collection: 'news', route: '/news/:slug' }]
      const problems = (await bootProblems(root, {}, [], undefined, routes)).map(problem => problem.message)

      expect(problems).toEqual([expect.stringContaining('the route /news/:slug of the collection news is served by no page')])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('a collection route read beyond the entries', () => {
  const localized = () => collection({ name: 'route-switch', load: () => [
    { slug: 'en/hello', data: { title: 'Hello', translationKey: 'greeting' } },
    { slug: 'fr/bonjour', data: { title: 'Bonjour', translationKey: 'greeting' } },
    { slug: 'en/only-en', data: { title: 'Only' } },
  ] }, { schema: t.Object({ title: t.String(), translationKey: t.Optional(t.String()) }), localized: true, route: '/blog/:slug' })

  it('gives the CMS the route before the url option and the guess from prerender', async () => {
    const posts = collection({ name: 'route-cms', load: () => [{ slug: 'hello', data: { title: 'Hello' } }] }, { schema, route: '/blog/:slug', url: () => '/other' })
    const before = registerCollections([['posts', posts]])
    const guessing = registerEditSite({ urls: async () => '/guessed' })

    try {
      expect((await entries('posts')).map(entry => entry.url)).toEqual(['/blog/hello'])
      expect(await entryPage('posts', { slug: 'a b', data: { title: 'X' } })).toBe('/blog/a%20b')
      expect(await entryPage('posts', { slug: '..', data: { title: 'X' } })).toBeUndefined()
    }
    finally {
      registerCollections(before)
      registerEditSite(guessing)
    }
  })

  it('has alternate() give the translation\'s own url, and the same path where the locale has none', async () => {
    const posts = localized()
    const settings = { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false }
    const state = (locale: string, path: string) => ({ locale, messages: new Map(), settings, path })

    expect(await runInLocale(state('en', '/blog/hello'), async () => {
      await posts.get('hello')

      return alternate('fr')
    })).toBe('/fr/blog/bonjour')

    expect(await runInLocale(state('fr', '/blog/bonjour'), async () => {
      await posts.get('bonjour')

      return [alternate('en'), alternate('fr')]
    })).toEqual(['/blog/hello', '/fr/blog/bonjour'])

    expect(await runInLocale(state('en', '/blog/only-en'), async () => {
      await posts.get('only-en')

      return alternate('fr')
    })).toBe('/fr/blog/only-en')

    expect(runInLocale(state('en', '/blog/hello'), () => alternate('fr'))).toBe('/fr/blog/hello')
  })

  it('leaves out an entry whose slug the route refuses, keeping the others', async () => {
    const docs = collection({ name: 'route-refused', load: () => [{ slug: 'ok', data: { title: 'Ok' } }, { slug: 'a//b', data: { title: 'Bad' } }] }, { schema, route: '/docs/*slug' })

    expect((await docs.all()).map(entry => entry.slug)).toEqual(['ok'])
  })

  it('has the locale rule take a dotted slug under a route for a page, not a file', () => {
    const base = { locales: ['en', 'fr'], defaultLocale: 'en', prefixDefault: false, pages: ['/blog/:slug', '/docs/*'] }
    const linked = linkedSettings(base, [{ pattern: '/blog/:slug' }, { pattern: '/docs/*' }], [{ options: { route: '/blog/:slug' } }, { options: { route: '/docs/*slug' } }])

    expect(linked.entryRoutes).toEqual(['/blog/:slug', '/docs/*'])
    expect(['/blog/v1.2', '/blog/v1.2/', '/docs/a/b.c', '/blog/cover.png'].map(href => localizedLink(base, href, 'fr'))).toEqual(['/blog/v1.2', '/blog/v1.2/', '/docs/a/b.c', '/blog/cover.png'])
    expect(['/blog/v1.2', '/blog/v1.2/', '/docs/a/b.c', '/blog/hello', '/other.png'].map(href => localizedLink(linked, href, 'fr'))).toEqual(['/fr/blog/v1.2', '/fr/blog/v1.2/', '/fr/docs/a/b.c', '/fr/blog/hello', '/other.png'])
  })
})

// Serves what the build wrote, asking for the feed and the page of each locale.
function serve(root: string, trailingSlash: string) {
  return `import { Elysia } from 'elysia'
import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}

const app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, base: '/site', trailingSlash: '${trailingSlash}', log: false, compress: false }))
const slash = ${JSON.stringify(trailingSlash === 'always')} ? '/' : ''
const text = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()
const feed = (xml: string) => [...xml.matchAll(/<link>(.*?)<\\/link>/g)].map(match => match[1])
const link = (html: string) => html.match(/<a class="self" href="(.*?)"/)?.[1]

console.log(JSON.stringify({
  en: { feed: feed(await text('/feeds/notes.xml')), page: link(await text(\`/notes/a\${slash}\`)) },
  fr: { feed: feed(await text('/fr/feeds/notes.xml')), page: link(await text(\`/fr/remarques/a\${slash}\`)) },
}))
process.exit(0)
`
}

describe('a collection route in a built site', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it.each(['never', 'always'])('links its feed and its pages under the base and each locale, with trailingSlash %s', async (trailingSlash) => {
    const root = await scratchDir('collection-route-')
    const slash = trailingSlash === 'always' ? '/' : ''

    roots.push(root)
    await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': config(trailingSlash), ...FILES, 'serve.ts': serve(root, trailingSlash) }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const build = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [built, builtErr, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

    if (code !== 0)
      throw new Error(`${built}${builtErr}`)

    const child = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, served] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (served !== 0)
      throw new Error(`${out}${err}`)

    expect(JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as unknown).toEqual({
      en: { feed: ['https://x.example/site/', `https://x.example/site/notes/a${slash}`], page: '/site/notes/a' },
      fr: { feed: [`https://x.example/site/fr${slash}`, `https://x.example/site/fr/remarques/a${slash}`], page: '/site/fr/remarques/a' },
    })
  }, 120_000)
})
