import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { bootProblems } from '../src/check/boot'
import { collection } from '../src/content'
import { registerCollections } from '../src/content/edit'
import { defaultFeedItem, feedDocument, feedPaths, resolvedFeed } from '../src/content/feed'
import { contentProblems } from '../src/content/server'
import { html } from '../src/runtime/rendered'
import { pagePrerender, routedCollections } from '../src/server/page-settings'
import { scratchDir } from './scratch'

const schema = t.Object({ title: t.String(), date: t.Optional(t.Date()), tags: t.Optional(t.Array(t.String())) })
const entry = (slug: string, data: Record<string, unknown>, url?: string) => ({ slug, data, headings: [], words: 0, readingTime: 0, Content: () => html('<p>Body</p>'), excerpt: '', body: '', html: '<p>Body</p>', file: `${slug}.md`, ...url !== undefined && { url } })

describe('a feed that implies what the collection holds', () => {
  it('takes its title from the collection, then the export name humanized', () => {
    const titled = collection({ name: 'titled', load: () => [] }, { schema, title: 'Our news', route: '/news/:slug', feed: { path: '/a.xml' } })
    const named = collection({ name: 'blogPosts', load: () => [] }, { schema, route: '/b/:slug', feed: { path: '/b.xml' } })

    expect(resolvedFeed(titled).title).toBe('Our news')
    expect(resolvedFeed(named).title).toBe('Blog posts')
  })

  it('reads the common fields, dating by publishAt before date, and refuses an entry without a title or a date', () => {
    const posts = collection({ name: 'dated', load: () => [] }, { schema: t.Object({ title: t.String(), date: t.Date(), tags: t.Array(t.String()), at: t.Date() }), publishAt: 'at', route: '/d/:slug', feed: { path: '/a.xml' } })
    const item = defaultFeedItem(posts)

    expect(item(entry('a', { title: 'A', date: new Date('2026-01-01'), at: new Date('2026-03-01'), tags: ['x'] }))).toMatchObject({ title: 'A', date: new Date('2026-03-01'), categories: ['x'] })
    expect(() => item(entry('b', { title: 'B' }))).toThrow('no date')
    expect(() => item(entry('c', { date: new Date() }))).toThrow('no `title`')
  })

  it('describes an item by its own description, else by the entry\'s excerpt, else by nothing', () => {
    const posts = collection({ name: 'described', load: () => [] }, { schema, route: '/d/:slug', feed: { path: '/a.xml' } })
    const item = defaultFeedItem(posts)
    const date = new Date('2026-01-01')

    expect(item({ ...entry('a', { title: 'A', date, description: 'Mine' }), excerpt: 'Lead.' }).description).toBe('Mine')
    expect(item({ ...entry('b', { title: 'B', date }), excerpt: 'Lead.' }).description).toBe('Lead.')
    expect(item(entry('c', { title: 'C', date })).description).toBeUndefined()
  })

  it('writes the modified time, the body, the categories and the image in each format, links under the mount point', () => {
    const entries = [entry('a', { title: 'A', date: new Date('2026-01-01') }, '/blog/a')]
    const feed = { path: '/blog/rss.xml', title: 'Blog', content: true, item: () => ({ title: 'A <b>', path: '/blog/a', date: new Date('2026-01-01'), updated: new Date('2026-01-03'), categories: ['x & y'], image: '/img/a.webp', author: 'Me' }) }
    const rss = feedDocument('rss', entries, feed, 'https://x.example/site', '/', 'always')
    const atom = feedDocument('atom', entries, feed, 'https://x.example/site', '/', 'always')
    const json = JSON.parse(feedDocument('json', entries, feed, 'https://x.example/site', '/', 'always')) as { items: Record<string, unknown>[], home_page_url: string }

    expect(rss).toContain('<content:encoded><![CDATA[<p>Body</p>]]></content:encoded>')
    expect(rss).toContain('<category>x &amp; y</category>')
    expect(rss).toContain('<enclosure url="https://x.example/site/img/a.webp" length="0" type="image/webp"/>')
    expect(rss).toContain('<link>https://x.example/site/blog/a/</link>')
    expect(atom).toContain('<updated>2026-01-03T00:00:00.000Z</updated><published>2026-01-01T00:00:00.000Z</published>')
    expect(atom).toContain('<category term="x &amp; y"/>')
    expect(json.home_page_url).toBe('https://x.example/site/')
    expect(json.items[0]).toMatchObject({ url: 'https://x.example/site/blog/a/', content_html: '<p>Body</p>', image: 'https://x.example/site/img/a.webp', tags: ['x & y'] })
  })

  it('keeps an item\'s own content and leaves a body out unless content is on', () => {
    const entries = [entry('a', { title: 'A' }, '/blog/a')]
    const item = () => ({ title: 'A', date: new Date('2026-01-01'), content: '<i>mine</i>' })

    expect(feedDocument('rss', entries, { path: '/rss.xml', title: 'B', item }, 'https://x.example')).toContain('<![CDATA[<i>mine</i>]]>')
    expect(feedDocument('rss', entries, { path: '/rss.xml', title: 'B', item: () => ({ title: 'A', date: new Date('2026-01-01') }) }, 'https://x.example', '/', undefined)).not.toContain('content:encoded')
  })

  it('serves a list of formats at the path and beside it', () => {
    expect(feedPaths({ path: '/blog/rss.xml' })).toEqual([{ format: 'rss', path: '/blog/rss.xml' }])
    expect(feedPaths({ path: '/blog/rss.xml', format: ['rss', 'json', 'atom'] }).map(each => each.path)).toEqual(['/blog/rss.xml', '/blog/rss.json', '/blog/rss.atom'])
    expect(feedPaths({ path: '/feed', format: 'json' })).toEqual([{ format: 'json', path: '/feed' }])
  })
})

describe('a feed body', () => {
  const feed = { path: '/rss.xml', title: 'B', content: true, item: () => ({ title: 'A', date: new Date('2026-01-01') }) }
  const withBody = (body: string) => [{ ...entry('a', { title: 'A' }, '/blog/a'), Content: () => html(body) }]

  it('writes root paths in tags only, srcset and poster too, and leaves a code sample as written', () => {
    const body = '<p><a href="/x">x</a> <a href="//cdn.example/y">y</a> <img src="/i.png" srcset="/a.avif 480w, /b.avif 960w" alt="a > b"> <video poster="/p.png"></video></p><pre><code>&lt;a href="/code"&gt; src="/also"</code></pre>'
    const rss = feedDocument('rss', withBody(body), feed, 'https://x.example/site')

    expect(rss).toContain('href="https://x.example/site/x"')
    expect(rss).toContain('href="//cdn.example/y"')
    expect(rss).toContain('src="https://x.example/site/i.png"')
    expect(rss).toContain('srcset="https://x.example/site/a.avif 480w, https://x.example/site/b.avif 960w"')
    expect(rss).toContain('poster="https://x.example/site/p.png"')
    expect(rss).toContain('&lt;a href="/code"&gt; src="/also"')
  })

  it('keeps ]]> in the content, the summary and the title well-formed', () => {
    const item = () => ({ title: 'T ]]> t', date: new Date('2026-01-01'), description: 'D ]]> d' })
    const atom = feedDocument('atom', withBody('<p>a ]]> b</p>'), { ...feed, item }, 'https://x.example')
    const rss = feedDocument('rss', withBody('<p>a ]]> b</p>'), { ...feed, item }, 'https://x.example')

    expect(atom).not.toContain(']]>')
    expect(atom).toContain('T ]]&gt; t')
    expect(rss).toContain('<![CDATA[<p>a ]]]]><![CDATA[> b</p>]]>')
    expect(rss).toContain('<title>T ]]&gt; t</title>')
  })

  it('leaves an entry whose content does not render at once to its summary, the rest of the feed served', () => {
    const entries = [{ ...entry('a', {}, '/blog/a'), Content: () => Promise.resolve(html('')) as never }, ...withBody('<p>fine</p>')]
    const rss = feedDocument('rss', entries, { ...feed, item: () => ({ title: 'A', date: new Date('2026-01-01'), description: 'sum' }) }, 'https://x.example')

    expect(rss.match(/<content:encoded>/g)).toHaveLength(1)
    expect(rss).toContain('<description>sum</description>')
  })

  it('leaves the type out of an enclosure it cannot name', () => {
    const rss = feedDocument('rss', withBody(''), { ...feed, item: () => ({ title: 'A', date: new Date('2026-01-01'), image: '/a.unknown' }) }, 'https://x.example')

    expect(rss).toContain('<enclosure url="https://x.example/a.unknown" length="0"/>')
  })
})

describe('what kay check finds in a feed', () => {
  it('refuses an empty list of formats and a feed with no item and no route', async () => {
    expect(() => collection({ name: 'empty', load: () => [] }, { schema, route: '/e/:slug', feed: { path: '/e.xml', format: [] } })).toThrow('lists no `format`')

    const root = await scratchDir('content-feed-check-')

    await Bun.write(`${root}/src/content.config.ts`, 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const posts = collection({ name: \'posts\', load: () => [] }, { schema: s.Object({ title: s.String() }), feed: { path: \'/rss.xml\' } })\n\nexport const notes = collection(\'content/notes\', { schema: s.Object({ title: s.Optional(s.String()) }), route: \'/notes/:slug\', feed: { path: \'/n.xml\' } })\n')
    await Bun.write(`${root}/src/content/notes/a.md`, 'body\n')

    const { problems } = await contentProblems(root, undefined, true)

    expect(problems.map(problem => problem.message)).toEqual([expect.stringMatching(/^the feed gives src\/content\/notes\/a.md no `title`/), expect.stringContaining('has no `item` and the collection no `route`')])
  })
})

describe('the prerender of a page at a collection\'s route', () => {
  it('is what the page sets, false included, else the collection', () => {
    const posts = collection({ name: 'pre-posts', load: () => [] }, { schema, route: '/blog/:slug' })
    const other = collection({ name: 'pre-other', load: () => [] }, { schema })
    const before = registerCollections([['posts', posts]])
    const route = { pattern: '/blog/:slug', params: ['slug'] }

    try {
      expect(pagePrerender({}, route)).toBe(posts)
      expect(pagePrerender({ page: { prerender: false } }, route)).toBe(false)
      expect(pagePrerender({ page: { prerender: other } }, route)).toBe(other)
      expect(pagePrerender({}, { pattern: '/about', params: [] })).toBeUndefined()
    }
    finally {
      registerCollections(before)
    }
  })
})

describe('kay check on a route two collections share', () => {
  it('reports the page that cannot tell which it lists, and not one that prerenders', async () => {
    const root = await scratchDir('content-ambiguous-')

    await Bun.write(`${root}/src/routes/blog/[slug].kay`, 'h1 Post\n')

    const routes = [{ collection: 'posts', route: '/blog/:slug' }, { collection: 'news', route: '/blog/:slug' }]

    expect((await bootProblems(root, {}, [], undefined, routes)).map(problem => problem.message)).toEqual([expect.stringContaining('the collections posts and news have the route /blog/:slug')])

    await Bun.write(`${root}/src/routes/blog/[slug].kay`, '--- server\nexport const page = { prerender: posts }\n---\nh1 Post\n')
    expect(await bootProblems(root, {}, [], undefined, routes)).toEqual([])

    // A single collection is no one the page lists the entries of.
    await Bun.write(`${root}/src/routes/blog/[slug].kay`, 'h1 Post\n')
    expect(await bootProblems(root, {}, [], undefined, [routes[0]!, { ...routes[1]!, single: true }])).toEqual([])
  })
})

describe('the page a collection\'s route names', () => {
  it('is the exact pattern of one param, never an optional or another path', () => {
    const posts = collection({ name: 'routed-page', load: () => [] }, { schema, route: '/blog/:slug' })
    const docs = collection({ name: 'routed-docs', load: () => [] }, { schema, route: '/docs/*slug' })
    const before = registerCollections([['posts', posts], ['docs', docs]])

    try {
      expect(routedCollections({ pattern: '/blog/:id', params: ['id'] })).toEqual([posts])
      expect(routedCollections({ pattern: '/docs/*', params: ['slug'] })).toEqual([docs])
      expect(routedCollections({ pattern: '/blog/:page?', params: ['page'] })).toEqual([])
      expect(routedCollections({ pattern: '/blog/tags/:tag', params: ['tag'] })).toEqual([])
      expect(routedCollections({ pattern: '/blog/:a/:b', params: ['a', 'b'] })).toEqual([])
    }
    finally {
      registerCollections(before)
    }
  })
})
