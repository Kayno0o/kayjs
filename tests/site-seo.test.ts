import type { OtherPage, RenderedPage, SiteSeo } from '../src/check/seo'
import { describe, expect, it } from 'bun:test'
import { pageSeoLints, TITLE_LENGTH } from '../src/check/seo'
import { siteSeoLints } from '../src/check/site-seo'

const SITE = 'https://example.com'
const CONFIG = '/app/kay.config.ts'

interface PageOptions {
  title?: string | undefined
  description?: string | undefined
  canonical?: string
  alternates?: [string, string][]
  links?: string[]
  locale?: string | undefined
  host?: string | undefined
  noindex?: boolean
  headNoindex?: boolean
  listed?: boolean
  guarded?: boolean
}

function head(options: PageOptions): string {
  const title = options.title === undefined ? '' : `<title>${options.title}</title>`
  const description = options.description === undefined ? '' : `<meta name="description" content="${options.description}">`
  const robots = options.headNoindex === true ? '<meta name="robots" content="noindex">' : ''
  const canonical = options.canonical === undefined ? '' : `<link rel="canonical" href="${options.canonical}">`
  const alternates = (options.alternates ?? []).map(([hreflang, href]) => `<link rel="alternate" hreflang="${hreflang}" href="${href}">`).join('')

  return `<head>${title}${description}${robots}${canonical}${alternates}</head>`
}

function page(path: string, options: PageOptions = {}): RenderedPage {
  const links = (options.links ?? []).map(href => `<a href="${href}">x</a>`).join('')

  return {
    path,
    file: `/app/src/routes${path === '/' ? '/index' : path}.kay`,
    locale: options.locale,
    host: options.host,
    html: `<html>${head({ title: path, description: `About ${path}`, ...options })}<body>${links}</body></html>`,
    noindex: options.noindex ?? false,
    sitemap: false,
    search: false,
    listed: options.listed ?? true,
    guarded: options.guarded ?? false,
  }
}

function other(path: string, status: number, location?: string): OtherPage {
  return { path, file: `/app/src/routes${path}.kay`, html: '', status, location }
}

const config: SiteSeo & { base?: string, redirects?: Record<string, string>, trailingSlash?: 'never' | 'always' | 'ignore' } = { site: SITE, favicon: false }

function lint(pages: RenderedPage[], others: OtherPage[] = [], over: Partial<typeof config> & { exported?: boolean, unseen?: boolean } = {}) {
  const { exported, unseen, ...rest } = over

  return siteSeoLints({ ...config, ...rest }, pages, others, { configFile: CONFIG, exported, unseen })
}

function summary(found: { code?: string | undefined, file: string, message: string }[]) {
  return found.map(d => [d.code, d.file.split('/').pop(), d.message])
}

describe('the head lints a page reads off the site', () => {
  it('reports a description another page of the same locale has, not one the site gives every page', () => {
    const same = (path: string, locale?: string) => page(path, { description: 'Same words', locale })
    const found = (pages: RenderedPage[], seo: SiteSeo = config) => pageSeoLints(seo, pages).filter(d => d.code === 'duplicate-description')

    expect(summary(found([same('/a'), same('/b')]))).toEqual([['duplicate-description', 'b.kay', '`/b` has the description of `/a`, "Same words"']])
    // One locale's copy of a page does not repeat another's.
    expect(found([same('/a', 'en'), same('/fr/a', 'fr')])).toEqual([])
    expect(found([same('/a', 'en'), same('/b', 'en'), same('/fr/a', 'fr'), same('/fr/b', 'fr')]).map(d => d.message)).toEqual(['`/b` has the description of `/a`, "Same words"', '`/fr/b` has the description of `/fr/a`, "Same words"'])
    // What every page inherits from `seo.description` is told once, in kay.config.ts.
    expect(found([same('/a'), same('/b')], { ...config, seo: { description: 'Same words' } })).toEqual([])
    // A page with none is not a duplicate of another with none.
    expect(found([page('/a', { description: '' }), page('/b', { description: '' })])).toEqual([])
  })

  it('reports a title over the length search results show', () => {
    const found = (title: string, seo: SiteSeo = config) => pageSeoLints(seo, [page('/a', { title })]).filter(d => d.code === 'long-title')
    const fits = 'a'.repeat(TITLE_LENGTH)

    expect(found(fits)).toEqual([])
    expect(summary(found(`${fits}b`))).toEqual([['long-title', 'a.kay', `The title of \`/a\` runs ${TITLE_LENGTH + 1} characters`]])
  })

  it('leaves a noindex page out of the description and title lints, as it has no snippet', () => {
    const long = 'a'.repeat(TITLE_LENGTH + 1)
    const pages = [page('/a', { description: 'Same' }), page('/b', { description: 'Same', noindex: true }), page('/c', { description: 'Same', headNoindex: true }), page('/d', { title: long, noindex: true }), page('/e', { title: long, headNoindex: true })]

    expect(pageSeoLints(config, pages).filter(d => d.code === 'duplicate-description' || d.code === 'long-title')).toEqual([])
  })

  it('sets the new lints with lints, and says nothing of a site that is not public', () => {
    const pages = [page('/a', { title: 'a'.repeat(TITLE_LENGTH + 1), description: 'Same' }), page('/b', { description: 'Same' })]
    const codes = (seo: SiteSeo) => pageSeoLints(seo, pages).filter(d => d.code === 'long-title' || d.code === 'duplicate-description').map(d => [d.code, d.severity])

    expect(codes(config)).toEqual([['long-title', 'warning'], ['duplicate-description', 'warning']])
    expect(codes({ ...config, lints: { 'long-title': 'allow', 'duplicate-description': 'deny' } })).toEqual([['duplicate-description', 'error']])
    expect(codes({ ...config, lints: { seo: 'allow' } })).toEqual([])
    expect(codes({ favicon: false })).toEqual([])
    expect(codes({ favicon: false, lints: { seo: 'deny' } })).toEqual([['long-title', 'error'], ['duplicate-description', 'error']])
  })
})

describe('orphan-page', () => {
  const orphans = (pages: RenderedPage[], others: OtherPage[] = [], over: Parameters<typeof lint>[2] = {}) => lint(pages, others, over).filter(d => d.code === 'orphan-page').map(d => d.message)
  // A page the sitemap does not list, which only a link reaches.
  const unlisted = (path: string, options: PageOptions = {}) => page(path, { listed: false, ...options })

  it('reports a page no link and no sitemap entry reaches, not one either does', () => {
    expect(orphans([page('/', { links: ['/about'] }), unlisted('/about'), unlisted('/lost')])).toEqual(['`/lost` has no link to it and is not in the sitemap'])
    // The sitemap lists it.
    expect(orphans([page('/'), page('/lost', { listed: true })])).toEqual([])
    // Another page's link is what counts, not its own.
    expect(orphans([page('/'), unlisted('/lost', { links: ['/lost'] })])).toEqual(['`/lost` has no link to it and is not in the sitemap'])
    // A link from a page the visitor reaches only as an error is no way in.
    expect(orphans([page('/'), unlisted('/lost')], [{ ...other('/gone', 404), html: '<a href="/lost">x</a>' }])).toEqual(['`/lost` has no link to it and is not in the sitemap'])
  })

  it('reads a link as the site writes it: with the base, a slash, a query, a hash, relative or absolute', () => {
    const links = (...hrefs: string[]) => [page('/', { links: hrefs }), unlisted('/blog/post'), unlisted('/team')]

    expect(orphans(links('/blog/post', '/team'))).toEqual([])
    expect(orphans(links('/blog/post/?page=2#top', '/team/'))).toEqual([])
    expect(orphans(links('/docs/blog/post', '/docs/team'), [], { base: '/docs' })).toEqual([])
    expect(orphans(links('https://example.com/blog/post', 'https://example.com/team'))).toEqual([])
    expect(orphans(links('blog/post', 'team'))).toEqual([])
    // Another site's page of the same path is no link to this one.
    expect(orphans(links('https://other.example/blog/post', 'mailto:a@b.c', '#team', 'tel:123'))).toEqual(['`/blog/post` has no link to it and is not in the sitemap', '`/team` has no link to it and is not in the sitemap'])
  })

  it('reads a relative link from the URL the browser holds the page at, which trailingSlash spells', () => {
    const pages = [page('/blog', { links: ['post'] }), unlisted('/blog/post'), unlisted('/post')]

    expect(orphans(pages, [], { trailingSlash: 'always' })).toEqual(['`/post` has no link to it and is not in the sitemap'])
    expect(orphans(pages, [], { trailingSlash: 'never' })).toEqual(['`/blog/post` has no link to it and is not in the sitemap'])
  })

  it('reads the link as the HTML spells it: entities, quotes, case, percent escapes, and leaves alone what is no address', () => {
    const raw = (html: string, ...paths: string[]) => [{ ...page('/'), html: `<html><head><title>Home</title></head><body>${html}</body></html>` }, ...paths.map(path => unlisted(path))]

    expect(orphans(raw('<a class="x" href="/a?x=1&amp;y=2">a</a><a href=\'/b\'>b</a><A HREF=/c>c</A>', '/a', '/b', '/c'))).toEqual([])
    expect(orphans(raw('<a href="/caf%c3%a9">a</a>', '/café'))).toEqual([])
    expect(orphans(raw('<a href="/caf%C3%A9">a</a>', '/café'))).toEqual([])
    expect(orphans(raw('<a href="http://[bad">a</a><a href="javascript:void(0)">b</a><a data-href="/a">c</a><link href="/a">', '/a'))).toEqual(['`/a` has no link to it and is not in the sitemap'])
  })

  it('leaves alone the entry points, noindex, guarded pages, a site without sitemap and a site with pages the build did not see', () => {
    expect(orphans([unlisted('/'), unlisted('/fr', { locale: 'fr' })])).toEqual([])
    expect(orphans([page('/'), unlisted('/a', { noindex: true }), unlisted('/b', { headNoindex: true }), unlisted('/c', { guarded: true })])).toEqual([])
    // With no `site` there is no sitemap to know, a server reading its origin when it boots.
    expect(orphans([page('/'), unlisted('/lost')], [], { site: undefined, seo: { name: 'Site' } })).toEqual([])
    // A page rendered per request may link to anything.
    expect(orphans([page('/'), unlisted('/lost')], [], { unseen: true })).toEqual([])
  })

  it('compares copies by host when locales go by domain, where they share a path', () => {
    const fr = unlisted('/about', { host: 'fr.example.com', locale: 'fr' })

    expect(orphans([page('/', { host: 'example.com', links: ['/about'] }), unlisted('/about', { host: 'example.com' }), fr])).toEqual(['`fr.example.com/about` has no link to it and is not in the sitemap'])
  })

  it('follows lints', () => {
    const pages = [page('/'), unlisted('/lost')]

    expect(lint(pages, [], { lints: { 'orphan-page': 'allow' } })).toEqual([])
    expect(lint(pages, [], { lints: { seo: 'deny' } }).map(d => [d.code, d.severity])).toEqual([['orphan-page', 'error']])
    expect(lint(pages, [], { site: undefined, seo: undefined, lints: { 'orphan-page': 'deny' } })).toEqual([])
  })
})

describe('broken-canonical', () => {
  const canonicals = (pages: RenderedPage[], others: OtherPage[] = [], over: Parameters<typeof lint>[2] = {}) => lint(pages, others, over).filter(d => d.code === 'broken-canonical').map(d => d.message)

  it('reports a canonical pointing at a page that is not a 200, a redirect or a 404', () => {
    const at = (canonical: string) => page('/a', { canonical })

    expect(canonicals([at(`${SITE}/gone`)], [other('/gone', 404)])).toEqual(['The canonical link of `/a` points at `/gone`, which answers 404'])
    expect(canonicals([at(`${SITE}/old`)], [other('/old', 308, '/new')])).toEqual(['The canonical link of `/a` points at `/old`, which redirects to `/new`'])
    expect(canonicals([at(`${SITE}/old`)], [], { redirects: { '/old': '/new' } })).toEqual(['The canonical link of `/a` points at `/old`, which redirects to `/new`'])
    expect(canonicals([at(`${SITE}/old/x`)], [], { redirects: { '/old/:slug': '/new/:slug' } })).toEqual(['The canonical link of `/a` points at `/old/x`, which redirects to `/new/x`'])
  })

  it('leaves alone a canonical to a page, to itself, to a page the build did not see or to another site', () => {
    expect(canonicals([page('/a', { canonical: `${SITE}/a` })])).toEqual([])
    expect(canonicals([page('/a', { canonical: `${SITE}/b` }), page('/b')])).toEqual([])
    // A route rendered per request, with params the build cannot list.
    expect(canonicals([page('/a', { canonical: `${SITE}/posts/42` })])).toEqual([])
    expect(canonicals([page('/a', { canonical: 'https://other.example/gone' })], [other('/gone', 404)])).toEqual([])
    expect(canonicals([page('/a')])).toEqual([])
  })

  it('reads the canonical with the base, a trailing slash and a relative path', () => {
    expect(canonicals([page('/a', { canonical: `${SITE}/docs/gone/` })], [other('/gone', 404)], { base: '/docs' })).toEqual(['The canonical link of `/a` points at `/gone`, which answers 404'])
    expect(canonicals([page('/a', { canonical: '/gone' })], [other('/gone', 404)])).toEqual(['The canonical link of `/a` points at `/gone`, which answers 404'])
  })

  it('compares by host when locales go by domain', () => {
    const fr = page('/gone', { host: 'fr.example.com' })

    expect(canonicals([page('/a', { canonical: 'https://fr.example.com/gone' }), fr], [{ ...other('/gone', 404), host: 'example.com' }])).toEqual([])
    expect(canonicals([page('/a', { canonical: 'https://example.com/gone', host: 'example.com' })], [{ ...other('/gone', 404), host: 'example.com' }])).toEqual(['The canonical link of `example.com/a` points at `example.com/gone`, which answers 404'])
  })

  it('follows lints', () => {
    const pages = [page('/a', { canonical: `${SITE}/gone` })]
    const others = [other('/gone', 404)]

    expect(lint(pages, others, { lints: { 'broken-canonical': 'allow' } })).toEqual([])
    expect(lint(pages, others, { lints: { 'broken-canonical': 'deny' } }).map(d => d.severity)).toEqual(['error'])
  })
})

describe('one-way-hreflang', () => {
  const alternates = (en: string, fr: string, extra: [string, string][] = []): [string, string][] => [['en', en], ['fr', fr], ...extra]
  const pair = (enBack: boolean, options: { frOptions?: PageOptions, enOptions?: PageOptions, xDefault?: boolean } = {}) => [
    page('/about', { locale: 'en', alternates: alternates(`${SITE}/about`, `${SITE}/fr/about`, options.xDefault ? [['x-default', `${SITE}/about`]] : []), ...options.enOptions, ...enBack ? {} : { alternates: [['en', `${SITE}/about`]] } }),
    page('/fr/about', { locale: 'fr', alternates: alternates(`${SITE}/about`, `${SITE}/fr/about`, options.xDefault ? [['x-default', `${SITE}/about`]] : []), ...options.frOptions }),
  ]
  const found = (pages: RenderedPage[], others: OtherPage[] = [], over: Parameters<typeof lint>[2] = {}) => lint(pages, others, over).filter(d => d.code === 'one-way-hreflang')

  it('reports an alternate that does not point back, at the page that should', () => {
    expect(found(pair(true))).toEqual([])
    expect(summary(found(pair(false)))).toEqual([['one-way-hreflang', 'about.kay', '`/about` has no alternate pointing back at `/fr/about`, which lists it as its `en` alternate']])
  })

  it('takes an x-default as an alternate and one pointing at the page itself', () => {
    expect(found(pair(true, { xDefault: true }))).toEqual([])
    // Told once for the pair, not for each alternate the page lists it by.
    expect(found(pair(false, { xDefault: true }))).toHaveLength(1)
  })

  it('leaves alone an alternate to a page the build did not see, to another site, or to a noindex page', () => {
    expect(found([page('/about', { alternates: [['en', `${SITE}/about`], ['fr', `${SITE}/fr/about`]] })])).toEqual([])
    expect(found([page('/about', { alternates: [['de', 'https://example.de/about']] }), page('/de', { })])).toEqual([])
    expect(found([page('/about', { alternates: [['fr', `${SITE}/fr/about`]] }), page('/fr/about', { noindex: true })])).toEqual([])
    expect(found([page('/about', { alternates: [['fr', `${SITE}/fr/about`]] }), page('/fr/about', { headNoindex: true })])).toEqual([])
  })

  it('reports an alternate pointing at a page that is not a 200', () => {
    expect(found([page('/about', { alternates: [['fr', `${SITE}/fr/about`]] })], [other('/fr/about', 404)]).map(d => d.message)).toEqual(['`/about` lists `/fr/about` as its `fr` alternate, which answers 404'])
  })

  it('compares by host when locales go by domain, where both copies share a path', () => {
    const en = page('/about', { host: 'example.com', locale: 'en', alternates: [['en', 'https://example.com/about'], ['fr', 'https://fr.example.com/about']] })
    const fr = page('/about', { host: 'fr.example.com', locale: 'fr', alternates: [['fr', 'https://fr.example.com/about'], ['en', 'https://example.com/about']] })

    expect(found([en, fr])).toEqual([])
    expect(found([en, { ...fr, html: fr.html.replace('<link rel="alternate" hreflang="en" href="https://example.com/about">', '') }]).map(d => d.message)).toEqual(['`fr.example.com/about` has no alternate pointing back at `example.com/about`, which lists it as its `fr` alternate'])
  })

  it('follows lints', () => {
    expect(found(pair(false), [], { lints: { 'one-way-hreflang': 'allow' } })).toEqual([])
    expect(found(pair(false), [], { lints: { seo: 'deny' } }).map(d => d.severity)).toEqual(['error'])
  })
})

describe('redirect-chain', () => {
  const chains = (redirects: Record<string, string | { to: string }>, pages: RenderedPage[] = [], others: OtherPage[] = [], over: Parameters<typeof lint>[2] = {}) => lint(pages, others, { redirects: redirects as Record<string, string>, ...over }).filter(d => d.code === 'redirect-chain')

  it('reports a redirect whose target redirects again, at kay.config.ts', () => {
    expect(summary(chains({ '/a': '/b', '/b': '/c' }))).toEqual([['redirect-chain', 'kay.config.ts', 'The redirect from `/a` goes to `/b`, which redirects to `/c`']])
    expect(chains({ '/a': '/b', '/c': '/d' })).toEqual([])
    expect(chains({ '/a': { to: '/b' }, '/b': { to: '/c' } }).map(d => d.message)).toEqual(['The redirect from `/a` goes to `/b`, which redirects to `/c`'])
  })

  it('reads params and a catch-all', () => {
    expect(chains({ '/blog/:slug': '/posts/:slug', '/posts/:id': '/articles/:id' }).map(d => d.message)).toEqual(['The redirect from `/blog/:slug` goes to `/posts/:slug`, which redirects to `/articles/:slug`'])
    expect(chains({ '/old/*': '/docs/*', '/docs/legacy': '/docs/guide' }).map(d => d.message)).toEqual([])
    expect(chains({ '/old/*': '/docs/legacy', '/docs/*': '/guide/*' }).map(d => d.message)).toEqual(['The redirect from `/old/*` goes to `/docs/legacy`, which redirects to `/guide/legacy`'])
    // A catch-all covers what follows its directory, not the directory.
    expect(chains({ '/x': '/docs', '/docs/*': '/guide/*' })).toEqual([])
    expect(chains({ '/blog/:slug': '/posts/:slug', '/posts/:id': '/articles/:id' }).map(d => d.help)).toEqual(['send `/blog/:slug` to `/articles/:slug` directly'])
  })

  it('reads a target with a query, a hash or a trailing slash, and leaves another site\'s alone', () => {
    expect(chains({ '/a': '/b/?x=1#top', '/b': '/c' })).toHaveLength(1)
    expect(chains({ '/a': 'https://other.example/b', '/b': '/c' })).toEqual([])
    expect(chains({ '/a': '/b', '/b': 'https://other.example/c' })).toHaveLength(1)
  })

  it('reports a redirect going round in a circle once for each', () => {
    expect(chains({ '/a': '/b', '/b': '/a' })).toHaveLength(2)
  })

  it('reads the pages the build rendered as a redirect too', () => {
    expect(chains({}, [], [other('/a', 308, '/b'), other('/b', 301, '/c')]).map(d => [d.file.split('/').pop(), d.message])).toEqual([['a.kay', 'The redirect from `/a` goes to `/b`, which redirects to `/c`']])
    expect(chains({ '/b': '/c' }, [], [other('/a', 308, '/b')]).map(d => d.message)).toEqual(['The redirect from `/a` goes to `/b`, which redirects to `/c`'])
    expect(chains({}, [page('/b')], [other('/a', 308, '/b')])).toEqual([])
    expect(chains({}, [], [other('/a', 404), other('/b', 308, '/a')])).toEqual([])
  })

  it('points at the line of the redirect in kay.config.ts', () => {
    const configSource = 'export default {\n  redirects: {\n    \'/a\': \'/b\',\n    \'/b\': \'/c\',\n  },\n}\n'
    const found = siteSeoLints({ ...config, redirects: { '/a': '/b', '/b': '/c' } }, [], [], { configFile: CONFIG, configSource })

    expect(found.map(d => [d.code, d.line])).toEqual([['redirect-chain', 3]])
  })

  it('reads the redirects without the base the pages are served under', () => {
    expect(chains({ '/a': '/b', '/b': '/c' }, [], [], { base: '/docs' })).toHaveLength(1)
    expect(chains({}, [], [other('/a', 308, '/docs/b'), other('/b', 308, '/c')], { base: '/docs' })).toHaveLength(1)
  })

  it('follows lints, and a site that is not public is told nothing', () => {
    expect(chains({ '/a': '/b', '/b': '/c' }, [], [], { lints: { 'redirect-chain': 'allow' } })).toEqual([])
    expect(chains({ '/a': '/b', '/b': '/c' }, [], [], { lints: { 'redirect-chain': 'deny' } }).map(d => d.severity)).toEqual(['error'])
    expect(chains({ '/a': '/b', '/b': '/c' }, [], [], { site: undefined })).toEqual([])
    expect(chains({ '/a': '/b', '/b': '/c' }, [], [], { site: undefined, exported: true })).toHaveLength(1)
  })
})
