import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const config = (trailingSlash: string) => `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ log: false, site: 'https://x.example', base: '/site', trailingSlash: '${trailingSlash}', i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } })\n`
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const MESSAGES = 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({})\n'
const SCHEMA = 's.Object({ title: s.String(), date: s.Date(), updated: s.Optional(s.Date()), tags: s.Optional(s.Array(s.String())), image: s.Optional(s.String()) })'
const PAGE = '--- server\nimport { {{name}} } from \'../../content.config\'\n\nconst entry = await {{name}}.get(ctx.params.slug) ?? ctx.notFound()\n---\nh1 {entry.data.title}\n'

// Two collections whose pages set nothing: notes, Markdown files and localized, and news, a loader's.
const FILES: Record<string, string> = {
  'src/messages/en.ts': MESSAGES,
  'src/messages/fr.ts': MESSAGES,
  'src/content.config.ts': `import { s } from 'kay'
import { collection } from 'kay/content'

export const notes = collection('content/notes', { schema: ${SCHEMA}, localized: true, route: '/notes/:slug', modified: 'updated', feed: { path: '/feeds/notes.xml', format: ['rss', 'atom', 'json'], content: true } })

export const news = collection({ name: 'news', load: () => [{ slug: 'big', data: { title: 'Big news', date: '2026-02-01', updated: '2026-02-03', tags: ['a', 'b'], image: '/big.png' }, body: 'Hello [there](/about)' }] }, { schema: ${SCHEMA}, route: '/news/:slug', modified: 'updated', title: 'The news', feed: { path: '/news.xml', content: true } })
`,
  'src/content/notes/en/a.md': '---\ntitle: first\ndate: 2026-01-01\nupdated: 2026-01-05\ntags: [x, y]\nimage: /a.png\n---\nbody [link](/notes/b)\n',
  'src/content/notes/fr/a.md': '---\ntitle: premier\ndate: 2026-01-01\n---\ncorps\n',
  'src/routes/notes/[slug].kay': PAGE.replaceAll('{{name}}', 'notes'),
  'src/routes/news/[slug].kay': PAGE.replaceAll('{{name}}', 'news'),
  'src/routes/about.kay': 'h1 About\n',
}

type Found = Record<string, { status: number, text: string }>

// Serves what the build wrote, or renders on request without one, and prints what a crawler and a reader would find.
function serve(root: string, trailingSlash: string, prebuilt: boolean) {
  return `import { Elysia } from 'elysia'
import { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}

const app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: ${prebuilt}, base: '/site', trailingSlash: '${trailingSlash}', log: false, compress: false }))
const get = async (path: string) => { const response = await app.handle(new Request(\`http://localhost\${path}\`)); return { status: response.status, text: await response.text() } }
const slash = ${JSON.stringify(trailingSlash === 'always')} ? '/' : ''

console.log(JSON.stringify({
  sitemap: await get('/sitemap.xml'),
  notes: await get(\`/notes/a\${slash}\`),
  fr: await get(\`/fr/notes/a\${slash}\`),
  news: await get(\`/news/big\${slash}\`),
  rss: await get('/feeds/notes.xml'),
  atom: await get('/feeds/notes.atom'),
  json: await get('/feeds/notes.json'),
  frJson: await get('/fr/feeds/notes.json'),
  newsRss: await get('/news.xml'),
}))
process.exit(0)
`
}

describe('a page that matches its collection\'s route', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  // Builds the site when `prebuilt`, serves it, and gives back what the script printed.
  async function visit(trailingSlash: string, prebuilt: boolean): Promise<Found> {
    const root = await scratchDir('content-inferred-')

    roots.push(root)
    await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': config(trailingSlash), ...FILES, 'serve.ts': serve(root, trailingSlash, prebuilt) }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    if (prebuilt) {
      const build = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
      const [built, builtErr, code] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])

      if (code !== 0)
        throw new Error(`${built}${builtErr}`)
    }

    const child = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, served] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    if (served !== 0)
      throw new Error(`${out}${err}`)

    return JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as Found
  }

  it.each([['never', true], ['always', true], ['never', false], ['always', false]] as const)('prerenders, lists and links with nothing set, with trailingSlash %s (built: %s)', async (trailingSlash, prebuilt) => {
    const slash = trailingSlash === 'always' ? '/' : ''
    const found = await visit(trailingSlash, prebuilt)
    const text = (name: string) => found[name]!.text

    for (const name of ['notes', 'fr', 'news', 'rss', 'atom', 'json', 'frJson', 'newsRss'])
      expect(found[name]!.status).toBe(200)

    // The sitemap lists each entry once per locale, the collection's modified field as lastmod.
    expect(text('sitemap')).toContain(`<loc>https://x.example/site/notes/a${slash}</loc><lastmod>2026-01-05T00:00:00.000Z</lastmod>`)
    expect(text('sitemap')).toContain(`<loc>https://x.example/site/fr/notes/a${slash}</loc>`)
    expect(text('sitemap')).toContain(`<loc>https://x.example/site/news/big${slash}</loc><lastmod>2026-02-03T00:00:00.000Z</lastmod>`)

    // The page head carries the modified time and the discovery links, under the base and in the page's locale.
    expect(text('notes')).toContain('<meta property="article:modified_time" content="2026-01-05T00:00:00.000Z">')
    expect(text('notes')).toContain('<link rel="alternate" type="application/rss+xml" title="Notes" href="/site/feeds/notes.xml">')
    expect(text('notes')).toContain('<link rel="alternate" type="application/feed+json" title="Notes" href="/site/feeds/notes.json">')
    expect(text('fr')).toContain('<link rel="alternate" type="application/atom+xml" title="Notes" href="/site/fr/feeds/notes.atom">')
    expect(text('fr')).not.toContain('article:modified_time')
    expect(text('news')).toContain('<link rel="alternate" type="application/rss+xml" title="The news" href="/site/news.xml">')

    // The feeds default their title and items from the collection, and carry the body, categories and image.
    expect(text('rss')).toContain('<title>Notes</title>')
    expect(text('rss')).toContain(`<link>https://x.example/site/notes/a${slash}</link>`)
    expect(text('rss')).toContain('<content:encoded><![CDATA[<p>body <a href="https://x.example/site/notes/b">link</a></p>')
    expect(text('rss')).toContain('<category>x</category><category>y</category>')
    expect(text('rss')).toContain('<enclosure url="https://x.example/site/a.png" length="0" type="image/png"/>')
    expect(text('rss')).toContain('<lastBuildDate>Mon, 05 Jan 2026 00:00:00 GMT</lastBuildDate>')
    expect(text('atom')).toContain('<updated>2026-01-05T00:00:00.000Z</updated><published>2026-01-01T00:00:00.000Z</published><content type="html">')

    const json = JSON.parse(text('json')) as { version: string, items: Record<string, unknown>[] }

    expect(json.version).toBe('https://jsonfeed.org/version/1.1')
    expect(json.items[0]).toMatchObject({ url: `https://x.example/site/notes/a${slash}`, tags: ['x', 'y'], image: 'https://x.example/site/a.png', date_modified: '2026-01-05T00:00:00.000Z' })

    const frJson = JSON.parse(text('frJson')) as { feed_url: string, items: { url: string }[] }

    expect(frJson.feed_url).toBe('https://x.example/site/fr/feeds/notes.json')
    expect(frJson.items.map(item => item.url)).toEqual([`https://x.example/site/fr/notes/a${slash}`])

    // A loader's collection works the same, its title the collection's.
    expect(text('newsRss')).toContain('<title>The news</title>')
    expect(text('newsRss')).toContain('<content:encoded><![CDATA[<p>Hello <a href="https://x.example/site/about">there</a></p>')
  }, 120_000)
})
