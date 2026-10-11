import type { Action, Failure } from '../src/runtime'
import type { ClientBuild, ClientManifest } from '../src/server/client'
import type { Encoding } from '../src/server/compress'
import type { Span, SpanOptions, Tracer } from '../src/server/trace'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { brotliDecompressSync } from 'node:zlib'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { parse, stringify } from 'devalue'
import { Elysia } from 'elysia'
import { outputDir } from '../src/build/assets'
import { projectPaths, resolveProject } from '../src/project'
import { ActionError } from '../src/runtime'
import { inlineScriptHashes, pages } from '../src/server'
import { readClient, readInlineStyles, readManifest, writeManifest } from '../src/server/client'
import { compressFiles, preferredEncoding } from '../src/server/compress'
import { sourceHash } from '../src/server/csp'
import { submittedValues } from '../src/server/flash'
import { prerenderPages } from '../src/server/prerender'
import { htmlFallbacks } from '../src/server/public'
import { renderPage } from '../src/server/render'
import { refuseClashes } from '../src/server/route-table'
import { scanRoutes } from '../src/server/routes'
import { speculationRules } from '../src/server/speculation'
import { KEEP_ALIVE_MS, streamDocument } from '../src/server/stream'
import { setTracer } from '../src/server/trace'
import { auth } from './fixtures/site/src/auth'
import { resetTodos } from './fixtures/site/src/data'

const app = await pages({ routes: 'tests/fixtures/site/src/routes', publicDir: 'tests/fixtures/site/public' })
// No _404.kay nor _error.kay: failures answer in plain text.
const bare = await pages({ routes: 'tests/fixtures/bare/src/routes', prebuilt: true })
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/
const ENTRY = /<script type="module" (?:async )?src="\/_kay\/([^"]+)"><\/script>/
const BODY = /<body>([\s\S]*)<\/body>/
// Any script but the speculation rules, which hold no code.
const SCRIPT = /<script(?! type="speculationrules")/
const INLINE_SCRIPTS = /<script>([\s\S]*?)<\/script>/g
const EVERY_INLINE_SCRIPT = /<script(?: type="speculationrules")?>([\s\S]*?)<\/script>/g
const SPECULATION = /<script type="speculationrules">(.*?)<\/script>/
const FORM_ACTION = /<form\b[^>]*\saction="([^"]*)"/
// happy-dom swaps in its own Request, which Elysia cannot read headers from.
const NativeRequest = Request

// What the entry leaves on the window: `hydrate` hydrating a root, with `ready` settling once the document it loaded in has hydrated.
interface ClientEntry {
  $kayHydrate: ((root?: ParentNode) => Promise<void>) & { ready: Promise<void> }
}

let hydrated = false

// The entry hydrates the document it loads in; a module is evaluated once per process, so later documents go through its `hydrate`.
async function hydrateFrom(html: string): Promise<void> {
  await import(join(outputDir(process.cwd()), 'dist', ENTRY.exec(html)![1]!))
  const { $kayHydrate: hydrate } = globalThis as unknown as ClientEntry

  await (hydrated ? hydrate() : hydrate.ready)
  hydrated = true
}

// Polls until `done` holds, for two seconds at most.
async function waitFor(done: () => boolean): Promise<void> {
  for (let tries = 0; !done(); tries++) {
    if (tries === 200)
      throw new Error('timed out')

    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function get(path: string): Promise<{ status: number, html: string, headers: Headers }> {
  const response = await app.handle(new Request(`http://localhost${path}`))

  return { status: response.status, html: (await response.text()), headers: response.headers }
}

afterAll(resetTodos)

describe('pages', () => {
  it('renders a page inside its layout with server data typed into the template', async () => {
    const { status, html, headers } = await get('/')

    expect(status).toBe(200)
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html).toStartWith('<!doctype html><html lang="en"><head>')
    expect(html).toContain('<header><a href="/" aria-current="page">Kay demo</a></header><main>')
    expect(html).toContain('<article class="card"><h2>Todos</h2><p>1 open</p><ul>')
    expect(html).toContain('<li><a href="/todos/2">Serve pages</a></li>')
  })

  it('ships the hydration script and the island bundle only to pages with islands', async () => {
    const home = await get('/')

    expect(home.html).toContain('<slot data-component="tests/fixtures/site/src/components/counter.kay"')
    expect(home.html).toContain('window._$K')
    expect(home.html).toContain('<slot data-component="tests/fixtures/site/src/components/counter.kay" data-props="[{&quot;start&quot;:1},1]"><button class="counter">Clicked <!--[-->1<!--]--></button></slot>')
    expect(home.html.replace(/<slot[\s\S]*<\/slot>/, '')).not.toContain('<!--[-->')
    const entry = (/<script type="module" src="(\/_kay\/[^"]+)"><\/script>/).exec(home.html)?.[1]

    expect(entry).toBeDefined()
    const bundle = await app.handle(new Request(`http://localhost${entry}`))

    expect(bundle.status).toBe(200)
    expect(await bundle.text()).toContain('counter.kay')

    const about = await get('/about')

    expect(about.html).toContain('<h1>About</h1>')
    expect(about.html).not.toMatch(SCRIPT)
  })

  it('merges the head blocks of layouts and page, the page winning per title and meta name', async () => {
    const about = (await get('/about')).html
    const home = (await get('/')).html

    expect(about).toStartWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet"')
    expect(about.match(/name="viewport"/g)).toHaveLength(1)
    expect(about).toContain('<meta name="viewport" content="width=device-width">')
    expect(home).toContain('<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(about).toContain('<title>About</title>')
    expect(about.match(/name="description"/g)).toHaveLength(1)
    expect(about).toContain('content="What this site is"')
    expect(home).toContain('<title>Kay demo</title>')
    expect(home).toContain('content="Kay demo, a site of todos"')
  })

  it('preloads the chunks of the islands a page renders, from a manifest a prebuilt server reads', async () => {
    const manifestFile = Bun.file(join(outputDir(process.cwd()), 'manifest.json'))
    const manifest = await manifestFile.json() as ClientManifest
    const counter = manifest.islands['tests/fixtures/site/src/components/counter.kay']!
    const home = (await get('/')).html

    expect(counter[0]).toMatch(/^\/_kay\/counter-\w+\.js$/)
    for (const chunk of new Set([...manifest.entryImports, ...counter]))
      expect(home).toContain(`<link rel="modulepreload" href="${chunk}">`)
    expect(home).not.toContain(manifest.islands['tests/fixtures/site/src/components/quick-add.kay']![0])
    expect(home).toContain(`<script type="module" src="${manifest.entry}"></script>`)
    expect((await get('/about')).html).not.toContain('modulepreload')

    const built = manifestFile.lastModified
    const prebuilt = await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: true })

    expect(await (await prebuilt.handle(new Request('http://localhost/'))).text()).toContain(`src="${manifest.entry}"`)
    expect(Bun.file(manifestFile.name!).lastModified).toBe(built)
  })

  it('links the stylesheets the layouts and the page import, through components, islands and modules, right after the viewport', async () => {
    const home = (await get('/')).html
    const links = [...home.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]!)
    const [layout, page] = await Promise.all(links.map(async link => (await app.handle(new Request(`http://localhost${link}`))).text()))

    expect(links).toHaveLength(2)
    expect(layout).toContain('background: url("/paper.png")')
    expect(page).toContain('.card {')
    expect(page).toContain('.counter {')
    expect((await get('/about')).html).toContain(`<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${links[0]}"><link rel="icon"`)
    expect((await Bun.file(projectPaths(process.cwd()).classes).text()).split('\n')).toEqual(expect.arrayContaining(['card', 'counter']))
  })

  it('writes the stylesheets into the head with inlineStyles, each let through a strict style-src by its hash under the mount point', async () => {
    for (const base of [undefined, '/docs']) {
      const inline = await pages({ routes: 'tests/fixtures/site/src/routes', publicDir: 'tests/fixtures/site/public', prebuilt: true, inlineStyles: true, base, security: { csp: { 'style-src': ['\'self\''] } } })
      const response = await inline.handle(new Request('http://localhost/'))
      const html = await response.text()
      const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]!)

      expect(html).not.toContain('rel="stylesheet"')
      expect(styles).toHaveLength(2)
      expect(styles[0]).toContain(`background: url("${base ?? ''}/paper.png")`)
      expect(styles[1]).toContain('.card {')
      expect(html).toContain(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>`)
      for (const style of styles)
        expect(response.headers.get('content-security-policy')).toContain(sourceHash(style))
    }
  })

  it('compresses only what lies around the inlined stylesheets, as gzip even to a browser taking brotli, the page decoding as it was', async () => {
    for (const base of [undefined, '/docs']) {
      const inline = await pages({ routes: 'tests/fixtures/site/src/routes', publicDir: 'tests/fixtures/site/public', prebuilt: true, inlineStyles: true, compress: true, base })
      const page = async (accept?: string) => inline.handle(new Request('http://localhost/', { headers: accept === undefined ? {} : { 'accept-encoding': accept } }))
      const plain = await (await page()).text()
      const spliced = await page('br, gzip')
      const brotli = await page('br')

      expect(plain).toContain('<style>')
      expect(spliced.headers.get('content-encoding')).toBe('gzip')
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await spliced.arrayBuffer())))).toBe(plain)
      expect(brotli.headers.get('content-encoding')).toBe('br')
      expect(brotliDecompressSync(new Uint8Array(await brotli.arrayBuffer())).toString()).toBe(plain)
    }
  })

  it('reads a stylesheet to inline with its relative URLs made absolute, the mount point the build added taken off, its line breaks read as the browser hashes them, and no way to close its element', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-inline-'))

    try {
      await Bun.write(join(dir, 'pages', 'home-1.css'), `.a{background:url("./a-1.png")}.b{background:url(../b.png?v=1#x)}.c{background:url(/docs/c.png)}.d{background:url(data:image/png;base64,AA)}.e{content:"</style>"}\r\n.f{background:url('./f g.png')}`)

      const inline = await readInlineStyles({ dir, styles: new Map([['/x.kay', '/_kay/pages/home-1.css']]) } as ClientBuild, '/docs')

      expect(inline.get('/_kay/pages/home-1.css')).toBe(`.a{background:url("/_kay/pages/a-1.png")}.b{background:url(/_kay/b.png?v=1#x)}.c{background:url(/c.png)}.d{background:url(data:image/png;base64,AA)}.e{content:"<\\/style>"}\n.f{background:url('/_kay/pages/f%20g.png')}`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ships the entry to a page whose islands all wait, without preloading their chunks', async () => {
    const manifest = await Bun.file(join(outputDir(process.cwd()), 'manifest.json')).json() as ClientManifest
    const { html } = await get('/lazy')

    expect(html).toContain('data-hydrate="idle"')
    expect(html).toContain(`<script type="module" src="${manifest.entry}"></script>`)
    expect(html).not.toContain(manifest.islands['tests/fixtures/site/src/components/counter.kay']![0])
  })

  it('serves the files components import at one content-hashed URL, the same on the server and in islands', async () => {
    const manifest = await Bun.file(join(outputDir(process.cwd()), 'manifest.json')).json() as ClientManifest
    const { html } = await get('/assets')
    // An imported image goes out as the variant of its size, which names the file it was made from.
    const logoSrc = (/<img class="static" src="([^"]+)"/).exec(html)![1]!
    const logo = decodeURIComponent((/src=([^&]+)&amp;/).exec(logoSrc)![1]!)
    const response = await app.handle(new Request(`http://localhost${logo}`))
    const chunk = await app.handle(new Request(`http://localhost${manifest.islands['tests/fixtures/site/src/components/brand.kay']![0]}`))

    expect(logo).toMatch(/^\/_kay\/assets\/logo-\w+\.png$/)
    expect(html).toContain(`class="brand" src="${logoSrc}"`)
    expect(html).toMatch(/<meta property="og:image" content="\/_kay\/assets\/og-\w+\.svg"/)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await response.bytes()).toEqual(await Bun.file('tests/fixtures/site/src/logo.png').bytes())
    expect(await chunk.text()).toContain(logo)
  })

  it('passes route params and honours notFound and redirect', async () => {
    expect((await get('/todos/1')).html).toContain('<h1>Write the compiler</h1><p class="status">Done</p>')
    expect((await get('/todos/9')).status).toBe(404)
    const redirected = await app.handle(new Request('http://localhost/todos/nope'))

    expect(redirected.status).toBe(302)
    expect(redirected.headers.get('location')).toBe('/')
    expect(redirected.headers.get('cache-control')).toBe('no-store')
    expect(redirected.headers.get('content-type')).toBeNull()
  })

  it('binds a catch-all segment', async () => {
    expect((await get('/docs/guide/intro')).html).toContain('<p class="path">Docs at guide/intro</p>')
  })

  it('decodes each param once and answers malformed encodings with 400', async () => {
    expect((await get('/todos/100%25')).status).toBe(302)
    expect((await get('/docs/a%20b/%2541')).html).toContain('<p class="path">Docs at a b/%41</p>')
    expect((await get('/docs/100%')).status).toBe(400)
    expect((await get('/todos/100%')).status).toBe(400)
  })

  it('refuses asset paths outside the client build or malformed', async () => {
    expect((await app.handle(new Request('http://localhost/_kay/..%2F..%2Fpackage.json'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/_kay/%E0'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/_kay/%00'))).status).toBe(404)
  })

  it('hydrates the island on the served page and leaves the static markup alone', async () => {
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    GlobalRegistrator.register()

    try {
      // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
      (new Function(INLINE_SCRIPT.exec(html)![1]!) as () => void)()
      document.body.innerHTML = BODY.exec(html)![1]!
      const button = document.querySelector('slot button')!
      const card = document.querySelector('article.card')!

      await hydrateFrom(html)
      expect(document.querySelector('slot button')).toBe(button)
      button.dispatchEvent(new Event('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(button.textContent).toBe('Clicked 2')
      expect(document.querySelector('article.card')).toBe(card)
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('redirects a page path ending in a slash to the one without, query kept, never off the site', async () => {
    const redirect = async (path: string) => {
      const response = await app.handle(new Request(`http://localhost${path}`))

      return [response.status, response.headers.get('location')]
    }

    expect(await redirect('/about/')).toEqual([308, '/about'])
    expect(await redirect('/about/?q=2')).toEqual([308, '/about?q=2'])
    expect(await redirect('/docs/guide/intro/')).toEqual([308, '/docs/guide/intro'])
    expect(await redirect('/admin/')).toEqual([308, '/admin'])
    expect(await redirect('/docs/')).toEqual([200, null])
    expect(await redirect('/docs//?q=2')).toEqual([308, '/docs/?q=2'])
    expect(await redirect('/docs/a//')).toEqual([308, '/docs/a'])

    // A catch-all at the root matches `//evil.example/`, whose redirect must stay on this site.
    const dir = await mkdtemp(join(process.cwd(), '.kay/routes-'))

    try {
      await Bun.write(join(dir, '[...path].kay'), '--- server\nconst path = ctx.params.path\n---\np {path}\n')
      // Prebuilt, so the shared client build the other tests read stays as it is.
      const site = new Elysia().use(await pages({ routes: dir, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const response = await site.handle(new Request('http://localhost//evil.example/'))

      expect([response.status, response.headers.get('location')]).toEqual([308, '/evil.example'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
    expect((await get('/')).status).toBe(200)
  })

  it('posts a plain form to its action and returns to the page', async () => {
    const home = await get('/')
    const form = (/<form class="add" action="([^"]+)" method="post" enctype="multipart\/form-data"><input name="title"/).exec(home.html)

    expect(form?.[1]).toBe('/_kay/action/tests/fixtures/site/src/routes/index.kay/add')
    const response = await app.handle(new Request(`http://localhost${form![1]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/' },
      body: new URLSearchParams({ title: 'From a form' }),
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost/')
    expect((await get('/')).html).toContain('From a form</a></li>')
  })

  it('refuses actions posted from another site and never redirects to one', async () => {
    const post = async (headers: Record<string, string>) => app.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/index.kay/add', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ title: 'Elsewhere' }),
    }))

    expect((await post({ origin: 'https://evil.example' })).status).toBe(403)
    // A browser leaving `Origin` out still says where the post comes from.
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await post({ 'origin': 'https://localhost', 'sec-fetch-site': 'same-origin' })).status).toBe(303)
    // Let through, then refused by the handler as already on the list, the page rendered in answer.
    expect((await post({ origin: 'https://localhost' })).status).toBe(409)

    const refused = await post({ referer: 'https://evil.example/' })

    expect(refused.headers.get('location')).toBeNull()
    expect(await refused.text()).toContain('<base href="http://localhost/">')
  })

  it('answers a fetch call with the result and rejects input the schema refuses', async () => {
    const call = async (body: unknown) => app.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/index.kay/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1' },
      body: stringify(body),
    }))
    const created = await call({ title: 'From fetch' })

    expect(created.status).toBe(200)
    expect(typeof parse(await created.text())).toBe('number')
    expect((await call({ title: '' })).status).toBe(422)
    expect((await call({})).status).toBe(422)
  })

  it('lets an island call a page action through its browser stub', async () => {
    const html = await (await app.handle(new Request('http://localhost/new'))).text()
    const realFetch = globalThis.fetch

    const requests: string[] = []

    // The page swap the call's refresh runs puts the next page's stylesheets in, which nothing serves here.
    GlobalRegistrator.register({ url: 'http://localhost/new', settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } })
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const response = await app.handle(new NativeRequest(url, init))

      requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)

      // As a browser's fetch gives it, which the page swap reads where the page came from.
      return Object.defineProperty(response, 'url', { value: url.href })
    }) as typeof fetch

    try {
      // eslint-disable-next-line no-new-func -- runs the inline hydration script, which happy-dom does not execute from markup
      (new Function(INLINE_SCRIPT.exec(html)![1]!) as () => void)()
      document.body.innerHTML = BODY.exec(html)![1]!
      await hydrateFrom(html)
      const input = document.querySelector<HTMLInputElement>('form.quick input')!

      input.value = 'From an island'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // A person types and submits in separate tasks.
      await new Promise(resolve => setTimeout(resolve, 0))
      document.querySelector('form.quick')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(document.querySelector('p.saved')?.textContent).toStartWith('Saved as ')
      // The call went through, so the page runs its loads again; it lands before the DOM goes away.
      await waitFor(() => requests.includes('GET /new') && !document.documentElement.hasAttribute('aria-busy'))
      expect(document.querySelector('p.saved')?.textContent).toStartWith('Saved as ')
    }
    finally {
      globalThis.fetch = realFetch
      await GlobalRegistrator.unregister()
    }
    expect((await get('/')).html).toContain('From an island</a></li>')
  })
})

describe('request context', () => {
  const ACCOUNT_ACTION = 'http://localhost/_kay/action/tests/fixtures/site/src/routes/account.kay/remember'
  // An Elysia guard covers an action only when it matches the action's own path, here holding the page's name.
  const guarded = new Elysia()
    .use(auth)
    .onBeforeHandle(({ user, path, status }) => user === undefined && path.includes('account') ? status(401, 'Sign in first') : undefined)
    .use(app)
  const request = async (path: string, init: RequestInit = {}) => guarded.handle(new Request(`http://localhost${path}`, init))

  it('passes what the app derives to pages as ctx.locals, behind its guard', async () => {
    expect((await request('/account')).status).toBe(401)
    expect(await (await request('/account', { headers: { 'x-user': 'ada' } })).text()).toContain('<p class="user">ada</p>')
  })

  it('passes ctx.locals to actions behind the same guard and sends the cookies they set', async () => {
    const post = async (headers: Record<string, string>) => guarded.handle(new Request(ACCOUNT_ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', ...headers },
      body: stringify({ theme: 'dark' }),
    }))
    const refused = await post({})
    const accepted = await post({ 'x-user': 'ada' })

    expect(refused.status).toBe(401)
    expect(parse(await accepted.text())).toBe('ada')
    expect(accepted.headers.get('set-cookie')).toBe('theme=dark; Path=/; HttpOnly; SameSite=Lax')
  })

  it('reads cookies in pages and keeps the ones an action sets across a form post', async () => {
    const page = await request('/account', { headers: { 'x-user': 'ada', 'cookie': 'theme=dark' } })

    expect(await page.text()).toContain('<p class="theme">dark</p>')
    expect(page.headers.get('set-cookie')).toBeNull()
    const form = await guarded.handle(new Request(ACCOUNT_ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/account', 'x-user': 'ada' },
      body: new URLSearchParams({ theme: 'light' }),
    }))

    expect(form.status).toBe(303)
    expect(form.headers.get('set-cookie')).toStartWith('theme=light;')
  })

  it('lets the outermost failing load decide the response', async () => {
    expect((await get('/gate')).status).toBe(404)
    const away = await app.handle(new Request('http://localhost/gate?away'))

    expect(away.status).toBe(302)
    expect(away.headers.get('location')).toBe('/about')
  })
})

describe('page query', () => {
  it('reads the search params against the page\'s schema, as typed values', async () => {
    const full = await get('/search?q=kay&page=3&tags=a&tags=b&exact=on')
    const bare = await get('/search?q=kay&utm_source=feed')

    expect(full.status).toBe(200)
    expect(full.html).toContain('<h1>Results for kay</h1><p class="types">number boolean</p><p class="values">3 a,b true</p>')
    expect(bare.html).toContain('<p class="values">1  false</p>')
  })

  it('answers a query the schema refuses with 400, through the error page', async () => {
    const refused = await get('/search?q=&page=x')

    expect(refused.status).toBe(400)
    expect(refused.html).toContain('<h1>Error 400</h1>')
    expect(refused.html).toContain('Invalid query: q: Type something to search; page: ')
  })

  it('checks the query only once the guards let the request through', async () => {
    const signedIn = new Elysia().use(auth).use(app)
    const visit = async (query: string, user?: string) => signedIn.handle(new NativeRequest(`http://localhost/admin/find?${query}`, { headers: user === undefined ? {} : { 'x-user': user } }))

    expect((await visit('n=x')).status).toBe(302)
    expect((await visit('n=x', 'bob')).status).toBe(403)
    expect((await visit('n=x', 'ada')).status).toBe(400)
    expect(await (await visit('n=2', 'ada')).text()).toContain('<p class="n">2</p>')
  })
})

describe('guards', () => {
  const PROMOTE = 'http://localhost/_kay/action/tests/fixtures/site/src/routes/admin/index.kay/promote'
  const signedIn = new Elysia().use(auth).use(app)
  const visit = async (user?: string) => signedIn.handle(new NativeRequest('http://localhost/admin', { headers: user === undefined ? {} : { 'x-user': user } }))
  const promote = async (body: unknown, headers: Record<string, string> = {}) => signedIn.handle(new NativeRequest(PROMOTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kay-action': '1', ...headers },
    body: stringify(body),
  }))

  it('runs before the page, sending its redirect and cookies', async () => {
    const away = await visit()

    expect(away.status).toBe(302)
    expect(away.headers.get('location')).toBe('/about')
    expect(away.headers.get('set-cookie')).toStartWith('seen=admin;')
    expect(await (await visit('ada')).text()).toContain('<nav class="admin">Admin tools</nav><h1>Admin</h1>')
  })

  it('renders a denial with the error page outside the guarded directory', async () => {
    const denied = await visit('bob')
    const html = await denied.text()

    expect(denied.status).toBe(403)
    expect(html).toContain('<header><a href="/">Kay demo</a></header>')
    expect(html).toContain('<p class="message">Admins only</p>')
    expect(html).not.toContain('Admin tools')
  })

  it('guards the actions of its pages once their input is valid', async () => {
    const away = await promote({ name: 'bob' })
    const denied = await promote({ name: 'bob' }, { 'x-user': 'bob' })

    // A call reads where to go off a header: `fetch` would follow `location` and parse the next page.
    expect(away.status).toBe(303)
    expect(away.headers.get('location')).toBeNull()
    expect(away.headers.get('x-kay-redirect')).toBe('/about')
    expect((await promote({ name: '' })).status).toBe(422)
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe('Admins only')
    expect((await promote({ name: '' }, { 'x-user': 'ada' })).status).toBe(422)

    const done = await promote({ name: 'bob' }, { 'x-user': 'ada' })

    expect(parse(await done.text())).toBe('bob is an admin')
    expect(done.headers.get('set-cookie')).toStartWith('seen=admin;')
  })

  it('sees what the app resolves, on pages and actions alike', async () => {
    const resolved = new Elysia().resolve({ as: 'global' }, ({ headers }) => ({ user: headers['x-user'] })).use(app)
    const page = await resolved.handle(new NativeRequest('http://localhost/admin', { headers: { 'x-user': 'ada' } }))
    const action = await resolved.handle(new NativeRequest(PROMOTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-user': 'ada' },
      body: stringify({ name: 'bob' }),
    }))

    expect(page.status).toBe(200)
    expect(parse(await action.text())).toBe('bob is an admin')
  })

  it('refuses a cross-site post before any guard runs', async () => {
    const response = await promote({ name: 'bob' }, { 'x-user': 'ada', 'origin': 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})

describe('route params in guards and actions', () => {
  const GUARD = 'import { guard } from \'kay\'\n\nexport default guard(({ params, headers, deny }) => {\n  headers.set(\'x-guarded\', JSON.stringify(params))\n\n  if (params.org !== \'acme\')\n    deny(403, `Not in ${String(params.org)}`)\n})\n'
  const ACTION = (name: string, body: string) => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\nexport const ${name} = action(t.Object({}), (_, ctx) => ctx.params)\n---\n${body}\n`
  const root = process.cwd()
  let dir = ''
  let served: Awaited<ReturnType<typeof pages>>

  const post = async (file: string, name: string, from?: string, headers: Record<string, string> = {}) => {
    const response = await served.handle(new NativeRequest(`http://localhost/_kay/action/${dir.slice(root.length + 1)}/${file}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', ...from === undefined ? {} : { referer: `http://localhost${from}` }, ...headers },
      body: stringify({}),
    }))

    return { status: response.status, guarded: response.headers.get('x-guarded'), body: response.ok ? parse(await response.text()) as unknown : await response.text() }
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(root, '.kay/routes-'))
    await Bun.write(join(dir, 'routes/orgs/[org]/_guard.ts'), GUARD)
    await Bun.write(join(dir, 'routes/orgs/[org]/_layout.kay'), ACTION('leave', 'slot'))
    await Bun.write(join(dir, 'routes/orgs/[org]/index.kay'), ACTION('rename', 'p Org'))
    await Bun.write(join(dir, 'routes/orgs/[org]/[team=integer].kay'), 'p Team\n')
    await Bun.write(join(dir, 'routes/index.kay'), 'p Home\n')
    await Bun.write(join(dir, 'routes/shelves/[shelf].kay'), '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const stock = action(t.Object({}), () => \'stocked\')\nexport const count = action(t.Object({}), (_, ctx) => ctx.params)\n---\np Shelf\n')
    await Bun.write(join(dir, 'routes/orgs/[org]/report.kay'), '--- server\nexport const page = { prerender: [{ org: \'acme\' }, { org: \'other\' }] }\n---\nh1 Report\n')
    await Bun.write(join(dir, 'api/orgs/_guard.ts'), GUARD)
    await Bun.write(join(dir, 'api/orgs/index.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/:org\', ({ params }) => params.org)\n')
    served = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: true })
    dir = join(dir, 'routes')
  })

  afterAll(async () => rm(dirname(dir), { recursive: true, force: true }))

  it('gives a page\'s guards its params, as its matchers read them', async () => {
    const team = await served.handle(new NativeRequest('http://localhost/orgs/acme/7'))
    const other = await served.handle(new NativeRequest('http://localhost/orgs/other'))

    expect(team.status).toBe(200)
    expect(team.headers.get('x-guarded')).toBe('{"org":"acme","team":7}')
    expect(other.status).toBe(403)
    expect(other.headers.get('x-guarded')).toBe('{"org":"other"}')
  })

  it('gives a prerendered page\'s guards its params', async () => {
    const manifest = (await readManifest(root))!

    try {
      await prerenderPages(resolveProject(root, { routes: dir }), (await readClient(root))!)
      const file = await Bun.file(join(outputDir(root), 'pages/orgs/acme/report.html')).text()
      const prerendered = await pages({ routes: dir, prebuilt: true })
      const acme = await prerendered.handle(new NativeRequest('http://localhost/orgs/acme/report'))
      const other = await prerendered.handle(new NativeRequest('http://localhost/orgs/other/report'))

      expect(await acme.text()).toBe(file)
      expect(acme.headers.get('x-guarded')).toBe('{"org":"acme"}')
      expect(other.status).toBe(403)
      expect(other.headers.get('x-guarded')).toBe('{"org":"other"}')
    }
    finally {
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('gives an action and its guards the params of the page it was posted from', async () => {
    expect(await post('orgs/_org_/index.kay', 'rename', '/orgs/acme')).toEqual({ status: 200, guarded: '{"org":"acme"}', body: { org: 'acme' } })
    expect(await post('orgs/_org_/index.kay', 'rename', '/orgs/other?tab=1')).toEqual({ status: 403, guarded: '{"org":"other"}', body: 'Not in other' })
    // kay's script names the page itself, which a `referrer-policy` cutting the path does not reach.
    expect(await post('orgs/_org_/index.kay', 'rename', '/', { 'x-kay-page': '/orgs/acme' })).toEqual({ status: 200, guarded: '{"org":"acme"}', body: { org: 'acme' } })
  })

  it('reads a plain form post\'s page from its Referer, or from the URL a refused one\'s form names', async () => {
    const response = await served.handle(new NativeRequest(`http://localhost/_kay/action/${dir.slice(root.length + 1)}/orgs/_org_/index.kay/rename?kay_back=${encodeURIComponent('/orgs/acme')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/orgs/other' },
      body: '',
    }))

    expect(response.status).toBe(303)
    expect(response.headers.get('x-guarded')).toBe('{"org":"acme"}')
    expect(response.headers.get('location')).toBe('http://localhost/orgs/acme')

    // Without one, its `Referer` names it.
    const plain = await served.handle(new NativeRequest(`http://localhost/_kay/action/${dir.slice(root.length + 1)}/orgs/_org_/index.kay/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/orgs/acme' },
      body: '',
    }))

    expect(plain.status).toBe(303)
    expect(plain.headers.get('x-guarded')).toBe('{"org":"acme"}')
  })

  it('gives a layout\'s action the params every page it wraps names', async () => {
    expect(await post('orgs/_org_/_layout.kay', 'leave', '/orgs/acme/7')).toEqual({ status: 200, guarded: '{"org":"acme"}', body: { org: 'acme' } })
    expect(await post('orgs/_org_/_layout.kay', 'leave', '/orgs/acme')).toEqual({ status: 200, guarded: '{"org":"acme"}', body: { org: 'acme' } })
    // No page serves it, the team's matcher refusing `x`.
    expect(await post('orgs/_org_/_layout.kay', 'leave', '/orgs/acme/x')).toEqual({ status: 400, guarded: null, body: 'Action posted from no page of its route' })
  })

  it('reads the page under the mount point the site is served at', async () => {
    const mounted = await pages({ routes: dir, prebuilt: true, base: '/repo' })
    const response = await mounted.handle(new NativeRequest(`http://localhost/_kay/action/${dir.slice(root.length + 1)}/orgs/_org_/index.kay/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/repo/orgs/acme' },
      body: stringify({}),
    }))

    expect(response.status).toBe(200)
    expect(parse(await response.text())).toEqual({ org: 'acme' })
  })

  it('refuses an action reading params posted from no page of its route, before its guards run', async () => {
    for (const from of [undefined, '/', '/orgs/acme/x', '/orgs/acme/7']) {
      expect(await post('orgs/_org_/index.kay', 'rename', from)).toEqual({ status: 400, guarded: null, body: 'Action posted from no page of its route' })
    }

    // A page on another host names no page of this site.
    expect((await served.handle(new NativeRequest(`http://localhost/_kay/action/${dir.slice(root.length + 1)}/orgs/_org_/index.kay/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'https://elsewhere.example/orgs/acme' },
      body: stringify({}),
    }))).status).toBe(400)
  })

  it('runs an action no guard covers from any page, refusing it once it reads the params of a post from no page of its route', async () => {
    expect(await post('shelves/_shelf_.kay', 'stock', '/')).toEqual({ status: 200, guarded: null, body: 'stocked' })
    expect(await post('shelves/_shelf_.kay', 'stock')).toEqual({ status: 200, guarded: null, body: 'stocked' })
    expect(await post('shelves/_shelf_.kay', 'count', '/shelves/a')).toEqual({ status: 200, guarded: null, body: { shelf: 'a' } })
    expect(await post('shelves/_shelf_.kay', 'count', '/')).toEqual({ status: 400, guarded: null, body: 'Action posted from no page of its route' })
  })

  it('gives an API route\'s guards its params', async () => {
    const allowed = await served.handle(new NativeRequest('http://localhost/api/orgs/acme'))
    const denied = await served.handle(new NativeRequest('http://localhost/api/orgs/other'))

    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('acme')
    expect(denied.status).toBe(403)
    expect(denied.headers.get('x-guarded')).toBe('{"org":"other"}')
  })
})

describe('await blocks', () => {
  it('keeps a page whose block is slow open past Bun\'s idle timeout, an empty comment at a time', async () => {
    const slow = (async () => {
      await Bun.sleep(KEEP_ALIVE_MS + 300)

      return 'late'
    })()
    const stream = streamDocument('<html><body>', [{ id: 'k1', value: slow, ready: (value: string) => value }], { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: '' }, false, () => undefined)
    const chunks: string[] = []

    for await (const chunk of stream)
      chunks.push(new TextDecoder().decode(chunk))

    expect(chunks[0]).toBe('<html><body>')
    expect(chunks[1]).toBe('<!---->')
    expect(chunks[2]).toStartWith('<template data-kay-await="k1">late</template>')
    expect(chunks.at(-1)).toBe('</body></html>')
  }, KEEP_ALIVE_MS + 5000)

  async function chunksOf(path: string): Promise<string[]> {
    const response = await app.handle(new Request(`http://localhost${path}`))
    const decoder = new TextDecoder()
    const chunks: string[] = []

    expect(response.status).toBe(200)
    for await (const chunk of response.body!)
      chunks.push(decoder.decode(chunk))

    return chunks
  }

  it('defers a promise the server fence leaves bare, rejecting while a later statement awaits, and renders any other value at once', async () => {
    const response = await bare.handle(new Request('http://localhost/later'))
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<p class="now">3</p>')
    expect(html).toContain('<p class="failed">Comments are down</p>')
  })

  it('sends the page at once, then each pending block as it settles', async () => {
    const [page, failed, ready, end] = await chunksOf('/feed?delay=30')

    expect(page).toContain('<h1>Feed</h1><!--kay-await:')
    expect(page).toContain('<p class="pending">Loading the feed</p>')
    expect(page).toContain('<p class="now">right away</p></main>')
    expect(page).not.toContain('Feed down')
    expect(failed).toContain('<p class="error">Feed down</p></template>')
    expect(ready).toContain('<ul><li>first</li><li>second</li></ul><slot')
    expect(ready).toContain('<script type="module" async src="/_kay/')
    expect(end).toBe('</body></html>')
  })

  it('reports a then block that throws while rendering, rather than showing its catch block', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const html = await (await bare.handle(new Request('http://localhost/stream'))).text()

      expect(html).not.toContain('Unavailable')
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('boom is not a function'))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('leaves a streamed rejection with no catch block to the log, a try around it having rendered already', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const html = await (await bare.handle(new Request('http://localhost/guarded'))).text()

      expect(html).not.toContain('Unavailable')
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Rows down'))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('loads the entry right after a shell holding islands, and streams nothing for an await inside a pending block', async () => {
    const [shell, block, end] = await chunksOf('/live')

    expect(shell).toContain('<script type="module" async src="/_kay/')
    expect(shell).not.toContain('<script type="module" src=')
    expect(shell).toContain('<p class="pending">Scoring</p>')
    expect(block).toContain('<p class="score">42</p>')
    expect(block).not.toContain('<script type="module"')
    expect(end).toBe('</body></html>')
  })

  it('swaps each block in for its pending one and hydrates the islands it brings', async () => {
    const html = (await chunksOf('/feed')).join('')

    GlobalRegistrator.register({ settings: { disableJavaScriptFileLoading: true, handleDisabledFileLoadingAsSuccess: true } })

    try {
      document.body.innerHTML = BODY.exec(html)![1]!
      // Runs the inline scripts in page order, as the browser does while the stream arrives; declarations must land on the global scope.
      for (const [, script] of html.matchAll(INLINE_SCRIPTS))
        // eslint-disable-next-line no-eval -- happy-dom does not execute scripts from markup
        (0, eval)(script!)
      await hydrateFrom(html)

      expect(document.querySelector('.pending')).toBeNull()
      expect(document.querySelector('template')).toBeNull()
      expect([...document.querySelectorAll('main > *')].map(element => element.tagName.toLowerCase())).toEqual(['h1', 'ul', 'slot', 'p', 'p'])
      expect(document.querySelector('p.error')?.textContent).toBe('Feed down')
      const button = document.querySelector('slot button')!

      button.dispatchEvent(new Event('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(button.textContent).toBe('Clicked 3')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})

describe('prerendering', () => {
  const routes = 'tests/fixtures/site/src/routes'

  it('renders the pages marked prerender once at build time and serves them behind their guards', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      expect(await prerenderPages(resolveProject(root, { routes }), (await readClient(root))!)).toBe(4)
      const file = await Bun.file(join(outputDir(root), 'pages/admin/report.html')).text()
      const signedIn = new Elysia().use(auth).use(await pages({ routes, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const visit = async (user: string, headers: Record<string, string> = {}) => signedIn.handle(new NativeRequest('http://localhost/admin/report', { headers: { 'x-user': user, ...headers } }))
      const served = await visit('ada')
      const etag = served.headers.get('etag')!

      expect(file).toContain('<nav class="admin">Admin tools</nav><h1>Report</h1>')
      expect(served.status).toBe(200)
      expect(await served.text()).toBe(file)
      expect(served.headers.get('cache-control')).toBe('private, no-cache')
      expect(served.headers.get('set-cookie')).toStartWith('seen=admin;')
      expect((await visit('ada', { 'if-none-match': `"other", W/${etag}` })).status).toBe(304)
      expect((await visit('bob')).status).toBe(403)
    }
    finally {
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('writes the stylesheets into the pages it prerenders with inlineStyles', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      await prerenderPages(resolveProject(root, { routes, inlineStyles: true }), (await readClient(root))!)
      const file = await Bun.file(join(outputDir(root), 'pages/admin/report.html')).text()

      expect(file).toContain('<style>')
      expect(file).toContain('background: url("/paper.png")')
      expect(file).not.toContain('rel="stylesheet"')
    }
    finally {
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('renders a dynamic route for each params its prerender export lists, and the others per request', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      await prerenderPages(resolveProject(root, { routes }), (await readClient(root))!)
      const served = new Elysia().use(await pages({ routes, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const visit = async (path: string) => {
        const response = await served.handle(new NativeRequest(`http://localhost${path}`))

        return { html: (await response.text()), etag: response.headers.get('etag') }
      }

      expect(await Bun.file(join(outputDir(root), 'pages/docs/guide/intro.html')).text()).toBe((await get('/docs/guide/intro')).html)
      expect(await Bun.file(join(outputDir(root), 'pages/docs/a%20b.html')).exists()).toBe(true)
      expect(await visit('/docs/guide/intro')).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at guide/intro</p>'), etag: expect.any(String) })
      expect(await visit('/docs/a%20b')).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at a b</p>'), etag: expect.any(String) })
      expect(await visit('/docs/other')).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at other</p>'), etag: null })

      // Served from its file however the path is spelled: as a browser sends it, or encoded.
      for (const spelling of ['/docs/a@b+c/d,e', '/docs/a%40b%2Bc/d%2Ce'])
        expect(await visit(spelling)).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at a@b+c/d,e</p>'), etag: expect.any(String) })
    }
    finally {
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('serves the compressed copies kay build writes to a browser accepting them, each encoding with its own tag', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const client = (await readClient(root))!

    try {
      await prerenderPages(resolveProject(root, { routes }), client)
      await Promise.all([compressFiles(client.dir), compressFiles(join(outputDir(root), 'pages'))])
      const served = new Elysia().use(await pages({ routes, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const fetch = async (path: string, headers: Record<string, string> = {}) => served.handle(new NativeRequest(`http://localhost${path}`, { headers }))
      const plain = await fetch(manifest.entry!)
      const brotli = await fetch(manifest.entry!, { 'accept-encoding': 'gzip, deflate, br, zstd' })
      const gzip = await fetch(manifest.entry!, { 'accept-encoding': 'gzip;q=1, br;q=0' })

      expect(plain.headers.get('content-encoding')).toBeNull()
      expect(plain.headers.get('vary')).toBe('accept-encoding')
      expect(brotli.headers.get('content-encoding')).toBe('br')
      expect(brotli.headers.get('content-type')).toBe(plain.headers.get('content-type'))
      expect(brotli.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

      const bytes = await plain.bytes()

      expect(new Uint8Array(brotliDecompressSync(await brotli.bytes()))).toEqual(bytes)
      expect(gzip.headers.get('content-encoding')).toBe('gzip')
      expect(Bun.gunzipSync(await gzip.bytes())).toEqual(bytes)

      // Each file was looked up once: the build's files never change outside development.
      const lookup = spyOn(Bun, 'file')

      try {
        const again = await fetch(manifest.entry!, { 'accept-encoding': 'br' })

        expect(lookup).not.toHaveBeenCalled()
        expect(new Uint8Array(brotliDecompressSync(await again.bytes()))).toEqual(bytes)
      }
      finally {
        lookup.mockRestore()
      }

      const file = await Bun.file(join(outputDir(root), 'pages/docs/guide/intro.html')).text()
      const page = await fetch('/docs/guide/intro', { 'accept-encoding': 'br' })
      const etag = page.headers.get('etag')!

      expect(page.headers.get('content-encoding')).toBe('br')
      expect(page.headers.get('vary')).toBe('accept-encoding')
      expect(etag).toEndWith('-br"')
      expect(brotliDecompressSync(await page.bytes()).toString()).toBe(file)
      expect((await fetch('/docs/guide/intro', { 'accept-encoding': 'br', 'if-none-match': etag })).status).toBe(304)
      expect((await fetch('/docs/guide/intro', { 'if-none-match': etag })).status).toBe(200)
      expect(await (await fetch('/docs/guide/intro')).text()).toBe(file)
      expect(new TextDecoder().decode(Bun.gunzipSync(await (await fetch('/docs/guide/intro', { 'accept-encoding': 'gzip' })).bytes()))).toBe(file)

      const signedIn = new Elysia().use(auth).use(await pages({ routes, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const report = await signedIn.handle(new NativeRequest('http://localhost/admin/report', { headers: { 'x-user': 'ada', 'accept-encoding': 'br' } }))

      expect(report.headers.get('content-encoding')).toBe('br')
      expect(report.headers.get('vary')).toBe('x-user, accept-encoding')
    }
    finally {
      for (const copy of new Bun.Glob('**/*.{br,gz}').scanSync(client.dir))
        await rm(join(client.dir, copy))
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('picks the encoding the request weighs highest among the copies at hand', () => {
    const both = new Set<Encoding>(['br', 'gzip'])

    expect(preferredEncoding('gzip, deflate, br', both)).toBe('br')
    expect(preferredEncoding('br;q=0.5, gzip', both)).toBe('gzip')
    expect(preferredEncoding('BR;Q=0, *', both)).toBe('gzip')
    expect(preferredEncoding('*', new Set<Encoding>(['gzip']))).toBe('gzip')
    expect(preferredEncoding('identity', both)).toBeUndefined()
    expect(preferredEncoding('br', new Set<Encoding>(['gzip']))).toBeUndefined()
    expect(preferredEncoding(null, both)).toBeUndefined()
  })

  it('asks a dynamic route marked prerender = true for the params to render', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const dir = await mkdtemp(join(root, '.kay/routes-'))

    try {
      await Bun.write(join(dir, 'posts/[slug].kay'), '--- server\nexport const page = { prerender: true }\n---\np {ctx.params.slug}\n')
      await expect(prerenderPages(resolveProject(root, { routes: dir }), (await readClient(root))!)).rejects.toThrow('so `prerender` lists them: export const page = { prerender: [{ slug: \'...\' }] }')
      await rm(join(dir, 'posts'), { recursive: true })
      // Another file, since the first one stays in the module cache.
      await Bun.write(join(dir, 'tags/[slug].kay'), '--- server\nexport const page = { prerender: [{ slug: 1 }] }\n---\np {ctx.params.slug}\n')
      await expect(prerenderPages(resolveProject(root, { routes: dir }), (await readClient(root))!)).rejects.toThrow('lists {"slug":1} in prerender, which needs a string for each of slug')
      await rm(join(dir, 'tags'), { recursive: true })
      await Bun.write(join(dir, 'files/[...path].kay'), '--- server\nexport const page = { prerender: [{ path: \'a/../../x\' }] }\n---\np {ctx.params.path}\n')
      await expect(prerenderPages(resolveProject(root, { routes: dir }), (await readClient(root))!)).rejects.toThrow('with no empty, . or .. segment')
      await rm(join(dir, 'files'), { recursive: true })
      await Bun.write(join(dir, 'notes/[slug].kay'), '--- server\nexport const page = { prerender: \'yes\' }\n---\np {ctx.params.slug}\n')
      await expect(prerenderPages(resolveProject(root, { routes: dir }), (await readClient(root))!)).rejects.toThrow('exports a prerender that is neither true, false')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('refuses to prerender two paths into one file', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const dir = await mkdtemp(join(root, '.kay/routes-'))

    try {
      await Bun.write(join(dir, 'index.kay'), '--- server\nexport const page = { prerender: true }\n---\np Home\n')
      await Bun.write(join(dir, '[slug].kay'), '--- server\nexport const page = { prerender: [{ slug: \'index\' }] }\nconst slug = ctx.params.slug\n---\np {slug}\n')
      await expect(prerenderPages(resolveProject(root, { routes: dir }), (await readClient(root))!)).rejects.toThrow('kay: /index and / would both be prerendered to index.html')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('logs what a prerendered page throws rather than handing it to the app\'s onError, and builds without the server\'s preview secret', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const dir = await mkdtemp(join(root, '.kay/routes-'))
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const reported: unknown[] = []

    try {
      await Bun.write(join(dir, 'plain.kay'), '--- server\nexport const page = { prerender: true }\n---\np Plain\n')
      expect(await prerenderPages(resolveProject(root, { routes: dir, preview: { secret: undefined as unknown as string } }), (await readClient(root))!)).toBe(1)

      await Bun.write(join(dir, 'broken.kay'), '--- server\nexport const page = { prerender: true }\nconst fail = () => {\n  throw new Error(\'no database at build time\')\n}\n\nfail()\n---\np Broken\n')
      await expect(prerenderPages(resolveProject(root, { routes: dir, onError: error => void reported.push(error) }), (await readClient(root))!)).rejects.toThrow('failed with 500')
      expect(reported).toEqual([])
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('no database at build time'))
    }
    finally {
      logged.mockRestore()
      await rm(dir, { recursive: true, force: true })
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('refuses to prerender a page that reads what only a request carries', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const account = (await scanRoutes(join(process.cwd(), routes))).find(route => route.pattern === '/account')!
      const response = await renderPage({ ...account, guards: [] }, { request: new Request('http://localhost/account') }, {}, (await readClient(process.cwd()))!, { prerendering: true })

      expect(response.status).toBe(500)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('a prerendered page renders once, at build time, so it has no ctx.locals'))
    }
    finally {
      logged.mockRestore()
    }
  })
})

describe('content security policy', () => {
  it('lists a hash for every inline script a page carries, streamed ones included', async () => {
    const hashes = new Set(inlineScriptHashes())
    const pagesHtml = await Promise.all(['/', '/about', '/feed', '/live'].map(async path => (await app.handle(new Request(`http://localhost${path}`))).text()))
    const inline = pagesHtml.flatMap(html => [...html.matchAll(EVERY_INLINE_SCRIPT)].map(match => match[1]!))

    expect(new Set(inline).size).toBe(4)
    for (const script of inline)
      expect(hashes).toContain(`'sha256-${new Bun.CryptoHasher('sha256').update(script).digest('base64')}'`)
  })
})

describe('prefetch', () => {
  it('prefetches the pages links point at on hover, leaving out the urls kay serves itself and opted-out links', async () => {
    const rules = JSON.parse(SPECULATION.exec((await get('/about')).html)![1]!) as unknown

    expect(rules).toEqual({ prefetch: [{
      source: 'document',
      where: { and: [{ href_matches: '/*' }, { not: { href_matches: '/_kay/*' } }, { not: { selector_matches: '[data-no-prefetch]' } }] },
      eagerness: 'moderate',
    }] })
    expect(speculationRules('eager')).toContain('"eagerness":"eager"')
    expect(speculationRules(false)).toBe('')

    const quiet = await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: true, prefetch: false })

    expect(await (await quiet.handle(new Request('http://localhost/about'))).text()).not.toContain('speculationrules')
  })
})

describe('without special pages', () => {
  const visit = async (path: string, served = bare) => {
    const response = await served.handle(new Request(`http://localhost${path}`))

    return { status: response.status, text: await response.text(), cookie: response.headers.get('set-cookie'), type: response.headers.get('content-type'), headers: response.headers }
  }

  it('answers in plain text, keeping the cookies and headers the guard or the page set', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect(await visit('/locked')).toMatchObject({ status: 403, text: 'Locked', cookie: expect.stringMatching(/^seen=locked;/), type: 'text/plain; charset=utf-8' })
      expect((await visit('/locked')).headers.get('x-guard')).toBe('locked')
      expect(await visit('/?fail')).toMatchObject({ status: 500, text: 'Internal Server Error', cookie: expect.stringMatching(/^visited=yes;/) })
      expect((await visit('/?fail')).headers.get('x-page')).toBe('index')
      expect(await visit('/?missing')).toMatchObject({ status: 404, text: 'Not found', cookie: expect.stringMatching(/^visited=yes;/) })
      expect(await visit('/?deny')).toMatchObject({ status: 403, text: 'Members only', cookie: expect.stringMatching(/^visited=yes;/) })

      const dev = await visit('/?fail', await pages({ routes: 'tests/fixtures/bare/src/routes', prebuilt: true, dev: true }))

      expect(dev).toMatchObject({ status: 500, text: expect.stringContaining('Kaboom'), cookie: expect.stringMatching(/^visited=yes;/), type: 'text/html; charset=utf-8' })
      expect(dev.headers.get('x-page')).toBe('index')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('keeps the default charset and viewport whatever a title holds', async () => {
    const { text } = await visit(`/?title=${encodeURIComponent('<meta charset="latin1"><meta name="viewport" content="width=1">')}`)

    expect(text).toContain('<meta charset="utf-8">')
    expect(text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
  })
})

describe('route scan', () => {
  it('refuses routes that clash or that a router would misread', async () => {
    const clash = async (files: string[]) => {
      const dir = await mkdtemp(join(tmpdir(), 'kay-routes-'))

      try {
        for (const file of files)
          await Bun.write(join(dir, file), '')

        refuseClashes(dir, await scanRoutes(dir))

        return 'scanned'
      }
      catch (error) {
        return (error as Error).message.replaceAll(dir, '<routes>')
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    const advice = '; give one a matcher, [id=integer], for the other to take what it refuses'

    expect(await clash(['about.kay', 'about/index.kay'])).toBe(`kay: <routes>/about.kay and <routes>/about/index.kay both serve /about${advice}`)
    expect(await clash(['todos/[id].kay', 'todos/[slug].kay'])).toBe(`kay: <routes>/todos/[id].kay and <routes>/todos/[slug].kay both serve /todos/:slug${advice}`)
    expect(await clash(['(site)/about.kay', 'about.kay'])).toBe(`kay: <routes>/(site)/about.kay and <routes>/about.kay both serve /about${advice}`)
    expect(await clash(['blog/index.kay', 'blog/[[page]].kay'])).toBe(`kay: <routes>/blog/[[page]].kay and <routes>/blog/index.kay both serve /blog${advice}`)
    // Positions, not names, reach the router, and a matcher lets a page take what another refuses.
    expect(await clash(['u/[id]/a.kay', 'u/[slug]/b.kay', 'todos/[id=integer].kay', 'todos/[slug].kay'])).toBe('scanned')
    expect(await clash(['x:y.kay'])).toBe('kay: <routes>/x:y.kay has a :, * or \' in its name, which the router cannot serve; rename it')
    expect(await clash(['it\'s.kay'])).toBe('kay: <routes>/it\'s.kay has a :, * or \' in its name, which the router cannot serve; rename it')
    expect(await clash(['todos/[id].kay', 'todos/new.kay', 'docs/[...path].kay', 'docs/index.kay', 'a b.kay'])).toBe('scanned')

    const dir = await mkdtemp(join(tmpdir(), 'kay-routes-'))

    try {
      await Bun.write(join(dir, 'about.kay'), '')
      await Bun.write(join(dir, 'about/index.kay'), '')
      expect(await scanRoutes(dir)).toHaveLength(2)
      await expect(pages({ routes: dir, prebuilt: true })).rejects.toThrow('both serve /about')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads layouts: false among the keys of page, and no other text saying it, an export of its own included', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-routes-'))
    const pages = {
      keyed: 'export const page = { noindex: true, layouts: false }',
      quoted: 'export const page = {\n  \'layouts\': false,\n}',
      own: 'export const layouts = false',
      nested: 'export const page = {\n  query: s.Object({ layouts: s.Boolean() }),\n  // layouts: false\n  noindex: /layouts: false/.test(\'\'),\n}',
      text: 'export const page = { sitemap: \'layouts: false\' }',
    }

    try {
      await Bun.write(join(dir, '_layout.kay'), 'slot\n')
      await Promise.all(Object.entries(pages).map(async ([name, code]) => Bun.write(join(dir, `${name}.kay`), `--- server\n${code}\n---\np\n`)))

      const routes = await scanRoutes(dir)

      expect(Object.fromEntries(Object.keys(pages).map(name => [name, routes.find(route => route.pattern === `/${name}`)!.layouts.length]))).toEqual({ keyed: 0, quoted: 0, own: 1, nested: 1, text: 1 })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('gives a guard the special pages outside its directory, bare for the routes root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-guards-'))

    try {
      for (const file of ['_guard.ts', '_layout.kay', '_error.kay', 'admin/_guard.ts', 'admin/_layout.kay', 'admin/_error.kay', 'admin/index.kay'])
        await Bun.write(join(dir, file), '')

      const [route] = await scanRoutes(dir)

      expect(route!.guards).toEqual([
        { file: join(dir, '_guard.ts'), special: { notFound: undefined, error: { file: join(dir, '_error.kay'), layouts: [] } } },
        { file: join(dir, 'admin/_guard.ts'), special: { notFound: undefined, error: { file: join(dir, '_error.kay'), layouts: [join(dir, '_layout.kay')] } } },
      ])
      expect(route!.special.error!.file).toBe(join(dir, 'admin/_error.kay'))
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('failed actions', () => {
  const ADD = 'http://localhost/_kay/action/tests/fixtures/site/src/routes/index.kay/add'
  const postForm = async (title: string, headers: Record<string, string> = {}) => app.handle(new Request(ADD, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/', ...headers },
    body: new URLSearchParams({ title, password: 'hunter2' }),
  }))

  it('shows a plain form what the schema refused, with the values it posted, rendering its page in answer', async () => {
    const page = await postForm('')
    const html = await page.text()

    expect(page.status).toBe(422)
    expect(page.headers.get('location')).toBeNull()
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(page.headers.get('cache-control')).toBe('private, no-store')
    expect(html).toContain('<base href="http://localhost/">')
    expect(html).toContain('<input name="title" placeholder="New todo" value="" aria-invalid="true">')
    expect(html).toContain('<p class="error">Write a title</p>')
    expect((await get('/')).html).not.toContain('class="error"')
  })

  it('shows a plain form what the handler passed to ctx.fail, never echoing a secret field', async () => {
    const html = await (await postForm('Serve pages')).text()

    expect(html).toContain('value="Serve pages"')
    expect(html).toContain('<p class="error">Already on the list</p>')
    expect(html).not.toContain('hunter2')
  })

  it('brings back a field however long, and leaves the base out of the page the swap shows', async () => {
    const long = 'é'.repeat(150)
    const swapped = await postForm(long.repeat(2), { 'x-kay-navigate': '1' })
    const html = await swapped.text()

    expect(swapped.status).toBe(422)
    expect(swapped.headers.get('x-kay-failure')).toBe('1')
    expect(html).toContain(`value="${long.repeat(2)}"`)
    expect(html).not.toContain('<base')
  })

  it('answers a call with the failure as JSON', async () => {
    const call = async (title: string) => app.handle(new Request(ADD, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({ title }) }))
    const refused = await call('')
    const duplicate = await call('Serve pages')

    expect(refused.status).toBe(422)
    expect(parse(await refused.text())).toEqual({ errors: { title: 'Write a title' }, data: undefined })
    expect(duplicate.status).toBe(409)
    expect(parse(await duplicate.text())).toEqual({ errors: {}, data: { message: 'Already on the list' } })
  })

  it('rejects a call from the browser with an ActionError carrying the failure', async () => {
    const { add } = await import(join(import.meta.dir, 'fixtures/site/src/routes/index.kay')) as { add: Action<{ title: string }, Failure<{ message: string }> | number> }
    const realFetch = globalThis.fetch
    let error: unknown

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => app.handle(new Request(new URL(String(input), 'http://localhost'), init))) as typeof fetch

    try {
      await add({ title: 'Serve pages' })
    }
    catch (caught) {
      error = caught
    }
    finally {
      globalThis.fetch = realFetch
    }

    expect(error).toBeInstanceOf(ActionError)
    expect(error).toMatchObject({ status: 409, errors: {}, data: { message: 'Already on the list' } })
    expect(add.refused(error) && error.data?.message).toBe('Already on the list')
  })

  it('renders the page the post came from under the mount point it is served at', async () => {
    const mounted = new Elysia().use(await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: false, security: false, base: '/repo' }))
    const page = await mounted.handle(new Request(ADD, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/repo/' }, body: new URLSearchParams({ title: '' }) }))
    const html = await page.text()

    expect(page.status).toBe(422)
    expect(html).toContain('<base href="http://localhost/repo/">')
    expect(html).toContain('<p class="error">Write a title</p>')
    expect(html).toContain('<a href="/repo/todos/1">')
  })

  it('renders the page again for a post refused again from the page a refusal answered, and goes back to it once one goes through', async () => {
    const mounted = new Elysia().use(await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: false, security: false, base: '/repo' }))
    // The browser shows the action's URL, so the next post sends it as its `Referer`, to where the page's form says, the mount point a proxy takes off.
    const post = async (url: string, referer: string, title: string) => mounted.handle(new Request(new URL(url.replace('/repo/', '/'), 'http://localhost'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', referer }, body: new URLSearchParams({ title }) }))
    const actionOf = (html: string) => FORM_ACTION.exec(html)![1]!.replaceAll('&amp;', '&')
    const shown = 'http://localhost/repo/_kay/action/tests/fixtures/site/src/routes/index.kay/add'
    const first = await post(ADD, 'http://localhost/repo/?sort=new', '')
    const second = await post(actionOf(await first.text()), shown, '')
    const html = await second.text()

    expect(second.status).toBe(422)
    expect(html).toContain('<base href="http://localhost/repo/?sort=new">')
    expect(html).toContain('<p class="error">Write a title</p>')

    const third = await post(actionOf(html), shown, '')
    const through = await post(actionOf(await third.text()), shown, `Refused twice ${Bun.randomUUIDv7()}`)

    expect(third.status).toBe(422)
    expect(through.status).toBe(303)
    expect(through.headers.get('location')).toBe('http://localhost/repo/?sort=new')
    // A page on another site named in the action's URL is not one to go back to.
    expect((await post(`${ADD}?kay_back=${encodeURIComponent('https://evil.example/')}`, 'http://localhost/repo/', `Elsewhere ${Bun.randomUUIDv7()}`)).headers.get('location')).toBe('http://localhost/repo/')
  })

  it('marks the success cookie Secure when the browser came over https, through a proxy too', async () => {
    const NOTHING = 'http://localhost/_kay/action/tests/fixtures/bare/src/routes/survey.kay/nothing'
    const cookieFrom = async (url: string, headers: Record<string, string> = {}) => (await bare.handle(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(),
    }))).headers.get('set-cookie')

    expect(await cookieFrom(NOTHING.replace('http:', 'https:'))).toContain('; Secure')
    expect(await cookieFrom(NOTHING, { 'x-forwarded-proto': 'https' })).toContain('; Secure')
    expect(await cookieFrom(NOTHING)).not.toContain('Secure')
  })

  it('ignores a forged flash cookie', async () => {
    const page = await app.handle(new Request('http://localhost/', { headers: { cookie: 'kay_flash=not-json' } }))

    expect(page.status).toBe(200)
    expect(await page.text()).not.toContain('class="error"')
  })
})

describe('public files', () => {
  it('serves them at their path, revalidated through their etag', async () => {
    const robots = await app.handle(new Request('http://localhost/robots.txt'))
    const etag = robots.headers.get('etag')!

    expect(robots.status).toBe(200)
    expect(await robots.text()).toStartWith('User-agent: *')
    expect(robots.headers.get('content-type')).toStartWith('text/plain')
    expect(robots.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    for (const tags of [etag, `"other", ${etag}`, etag.slice(2), '*'])
      expect((await app.handle(new Request('http://localhost/robots.txt', { headers: { 'if-none-match': tags } }))).status).toBe(304)

    expect((await app.handle(new Request('http://localhost/robots.txt', { headers: { 'if-none-match': '"other"' } }))).status).toBe(200)
    expect((await app.handle(new Request('http://localhost/.well-known/security.txt'))).status).toBe(200)
  })

  it('serves nothing outside the directory', async () => {
    expect((await app.handle(new Request('http://localhost/..%2Fsrc%2Fdata.ts'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/.well-known/..%2F..%2Fsrc%2Fdata.ts'))).status).toBe(404)
  })

  it('serves a file at the URL a browser sends for its name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-public-'))

    try {
      for (const name of ['logo@2x.png', 'a+b,c;d=e&f$[1]|.txt', 'it\'s.txt', 'c:d.txt', 'star*.txt', 'sp ace é%.txt'])
        await Bun.write(join(dir, name), name)

      const served = await pages({ routes: 'tests/fixtures/bare/src/routes', publicDir: dir, prebuilt: true })
      const visit = async (path: string) => {
        const response = await served.handle(new Request(`http://localhost${path}`))

        return response.status === 200 ? response.text() : response.status
      }

      expect(await visit('/logo@2x.png')).toBe('logo@2x.png')
      expect(await visit('/logo%402x.png')).toBe('logo@2x.png')
      expect(await visit('/a+b,c;d=e&f$[1]|.txt')).toBe('a+b,c;d=e&f$[1]|.txt')
      expect(await visit('/sp%20ace%20%C3%A9%25.txt')).toBe('sp ace é%.txt')
      // Elysia would read these characters as a parameter, a wildcard or code, so only their encoded form serves them.
      expect(await visit('/it%27s.txt')).toBe('it\'s.txt')
      expect(await visit('/c%3Ad.txt')).toBe('c:d.txt')
      expect(await visit('/star%2A.txt')).toBe('star*.txt')
      expect(await visit('/cZZ')).toBe(404)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves an HTML file without its .html, and an index.html at its directory, as a static host does, a file or a page at that path winning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-public-'))

    try {
      const files = { 'books.html': 'books', 'books/index.html': 'books index', 'shelf/index.html': 'shelf', 'notes': 'notes', 'notes.html': 'notes html', 'about.html': 'about html', 'index.html': 'home html', 'docs/guide.html': 'guide' }

      for (const [name, body] of Object.entries(files))
        await Bun.write(join(dir, name), body)

      const served = await pages({ routes: 'tests/fixtures/site/src/routes', publicDir: dir, prebuilt: true })
      const visit = async (path: string) => (await served.handle(new Request(`http://localhost${path}`))).text()

      expect(await visit('/books')).toBe('books')
      expect(await visit('/books/index')).toBe('books index')
      expect(await visit('/shelf')).toBe('shelf')
      expect(await visit('/shelf/index.html')).toBe('shelf')
      expect(await visit('/notes')).toBe('notes')
      expect(await visit('/notes.html')).toBe('notes html')
      expect(await visit('/about')).not.toBe('about html')
      expect(await visit('/')).not.toBe('home html')
      expect(await visit('/about.html')).toBe('about html')
      // A page taking the path through a parameter loses to it, as it loses to the file itself.
      expect(await visit('/docs/guide')).toBe('guide')
      expect(htmlFallbacks([{ path: 'index.html', url: '/index.html' }], new Set())).toEqual([{ path: 'index.html', url: '/index' }, { path: 'index.html', url: '/' }])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to boot when a file and a page share a path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-public-'))

    try {
      await Bun.write(join(dir, 'about'), 'shadowed')
      await expect(pages({ routes: 'tests/fixtures/site/src/routes', publicDir: dir, prebuilt: true })).rejects.toThrow('and a page both serve /about')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('problems kay check reports', () => {
  it('reach the problems panel of every page in development, never in production', async () => {
    const routes = 'tests/fixtures/problems/src/routes'
    const dev = new Elysia().use(await pages({ routes, dev: true, security: false }))
    const block = (/<script type="application\/json" id="kay-check-problems">(.*?)<\/script>/).exec(await (await dev.handle(new Request('http://localhost/'))).text())?.[1]

    expect(block).not.toContain('<')
    expect(JSON.parse(block!)).toContainEqual(expect.stringMatching(/^error\[missing-alt\]: An `img` needs `alt`\n --> tests\/fixtures\/problems\/src\/routes\/index\.kay:1:1\n/))

    const production = new Elysia().use(await pages({ routes, prebuilt: false, security: false }))

    expect(await (await production.handle(new Request('http://localhost/'))).text()).not.toContain('kay-check-problems')
  })
})

describe('special pages', () => {
  it('answers a throwing action with a 500 and a message for the whole form, and logs its stack at the .kay line', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const response = await app.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/boom.kay/explode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kay-action': '1' },
        body: stringify({}),
      }))

      expect(response.status).toBe(500)
      expect(parse(await response.text())).toEqual({ errors: { '': 'Something went wrong on our side; try again later' }, data: undefined })
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^kay: POST \S+explode, request \S+\nError: Kaboom in an action\n\s+at \S+ \(\S+\/boom\.kay:6:13\)/))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('hands every error it logs to onError with its request, and logs a reporter that throws', async () => {
    const reported: string[] = []
    const watched = await pages({ routes: 'tests/fixtures/site/src/routes', prebuilt: true, onError: (error, request) => {
      reported.push(`${new URL(request.url).pathname}${new URL(request.url).search}: ${(error as Error).message}`)

      if (reported.length === 1)
        throw new Error('Tracker down')
    } })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect((await watched.handle(new Request('http://localhost/boom?fail'))).status).toBe(500)
      expect((await watched.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/boom.kay/explode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({}) }))).status).toBe(500)
      expect(await (await watched.handle(new Request('http://localhost/boom?later'))).text()).not.toContain('Kaboom')
      expect(await (await watched.handle(new Request('http://localhost/boom'))).text()).toContain('<p>Fine</p>')
      expect(reported).toEqual(['/boom?fail: Kaboom', '/_kay/action/tests/fixtures/site/src/routes/boom.kay/explode: Kaboom in an action', '/boom?later: Kaboom later'])
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^kay: GET \/boom, request \S+: onError failed\nError: Tracker down/))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('logs an API route that throws and hands it to onError, answering a generic 500 in production, unless its module answers it', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.kay/api-'))
    const reported: string[] = []
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await Bun.write(join(dir, 'api/items.ts'), 'import { t } from \'elysia\'\nimport { api } from \'kay/server\'\n\nexport default api()\n  .get(\'/broken\', () => { throw new Error(\'Secret detail\') })\n  .get(\'/teapot\', ({ status }) => { throw status(418, \'Short and stout\') })\n  .post(\'/\', ({ body }) => body, { body: t.Object({ name: t.String() }) })\n')
      await Bun.write(join(dir, 'api/own.ts'), 'import { api } from \'kay/server\'\n\nexport default api().onError(() => \'Answered by the module\').get(\'/\', () => { throw new Error(\'Handled\') })\n')
      const served = await pages({ routes: 'tests/fixtures/bare/src/routes', api: join(dir, 'api'), prebuilt: true, onError: (error, request) => void reported.push(`${new URL(request.url).pathname}: ${(error as Error).message}`) })
      const broken = await served.handle(new Request('http://localhost/api/items/broken'))

      expect(broken.status).toBe(500)
      expect(await broken.text()).toBe('Internal Server Error')
      expect((await served.handle(new Request('http://localhost/api/items/teapot'))).status).toBe(418)
      expect((await served.handle(new Request('http://localhost/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))).status).toBe(422)
      expect(await (await served.handle(new Request('http://localhost/api/own'))).text()).toBe('Answered by the module')
      expect(reported).toEqual(['/api/items/broken: Secret detail'])
      expect(logged).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^kay: GET /api/items/broken, request ${broken.headers.get('x-request-id')}\nError: Secret detail\n`)))

      const dev = await pages({ routes: 'tests/fixtures/bare/src/routes', api: join(dir, 'api'), prebuilt: true, dev: true })

      expect(await (await dev.handle(new Request('http://localhost/api/items/broken'))).text()).toBe('Secret detail')
    }
    finally {
      logged.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders the nearest _404.kay inside its layouts, for notFound and for URLs no page serves', async () => {
    const missingTodo = await get('/todos/9')
    const unmatched = await get('/no/such/page')

    expect(missingTodo.status).toBe(404)
    expect(missingTodo.html).toContain('<header><a href="/">Kay demo</a></header><main><p class="todo-missing">No such todo</p></main>')
    expect(unmatched.status).toBe(404)
    expect(unmatched.html).toContain('<main><h1>Nothing here</h1></main>')
  })

  it('leaves the routes the app adds after the pages alone', async () => {
    const withApi = new Elysia().use(app).get('/api/ping', () => 'pong')

    expect(await (await withApi.handle(new Request('http://localhost/api/ping'))).text()).toBe('pong')
  })

  it('renders _error.kay with a generic message in production and logs the error', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const { status, html } = await get('/boom?fail')

      expect(status).toBe(500)
      expect(html).toContain('<h1>Error 500</h1><p class="message">Internal Server Error</p>')
      expect(html).not.toContain('Kaboom')
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^kay: GET \/boom, request \S+\nError: Kaboom\n\s+at load \(\S+\/boom\.kay:10:13\)/))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('shows the message and the stack in development, times each load and shows browser problems on the page, never in production', async () => {
    const dev = await pages({ routes: 'tests/fixtures/site/src/routes', dev: true })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const html = await (await dev.handle(new Request('http://localhost/boom?fail'))).text()

      expect(html).toContain('<p class="message">Kaboom</p>')
      expect(html).toMatch(/<pre class="stack">Error: Kaboom\n\s+at load \(\S+\/boom\.kay:10:13\)/)
      expect(await (await dev.handle(new Request('http://localhost/boom?bare'))).text()).toMatch(/<pre class="stack">Error: Kaboom bare\n\s+at load \(\S+\/boom\.kay:14:21\)/)
      expect(html).toMatch(/<meta name="kay-boot" content="[\w-]+"><script>[^<]*new EventSource\("\/_kay\/dev\/events"\)/)
      expect((await dev.handle(new Request('http://localhost/_kay/dev/events'))).headers.get('content-type')).toBe('text/event-stream')

      const page = await dev.handle(new Request('http://localhost/'))
      const timing = page.headers.get('server-timing')
      const script = (/<script>([^<]*kay-problems[^<]*)<\/script>/).exec(await page.text())![1]!

      expect(inlineScriptHashes({ dev: true })).toContain(`'sha256-${new Bun.CryptoHasher('sha256').update(script).digest('base64')}'`)
      expect((await get('/')).html).not.toContain('kay-problems')

      expect(timing).toMatch(/^load-0;desc="tests\/fixtures\/site\/src\/routes\/_layout\.kay";dur=\d+\.\d, load-1;desc="tests\/fixtures\/site\/src\/routes\/index\.kay";dur=\d+\.\d, render;dur=\d+\.\d$/)
      expect((await get('/')).headers.get('server-timing')).toBeNull()
    }
    finally {
      logged.mockRestore()
    }
  })
})

interface RecordedSpan {
  name: string
  // The span active where it started, as OpenTelemetry's context manager tracks it.
  parent?: string | undefined
  kind?: number | undefined
  attributes: Record<string, unknown>
  status?: number | undefined
}

// A tracer keeping each span as it ends, the active one tracked across awaits.
function recordingTracer(): { tracer: Tracer, ended: RecordedSpan[] } {
  const active = new AsyncLocalStorage<string>()
  const ended: RecordedSpan[] = []
  const open = (name: string, options?: SpanOptions): RecordedSpan => ({ name, parent: active.getStore(), kind: options?.kind, attributes: { ...options?.attributes } })
  const span = (record: RecordedSpan): Span => ({
    setAttribute: (key, value) => void (record.attributes[key] = value),
    setStatus: ({ code }) => void (record.status = code),
    recordException: () => undefined,
    end: () => void ended.push(record),
  })

  return {
    tracer: {
      startSpan: (name, options) => span(open(name, options)),
      startActiveSpan: (name, options, fn) => {
        const record = open(name, options)

        return active.run(name, () => fn(span(record))) as ReturnType<typeof fn>
      },
    },
    ended,
  }
}

describe('tracing and timing in production', () => {
  afterAll(() => setTracer(undefined))

  it('times each load in a Server-Timing header when the config asks', async () => {
    const timed = await pages({ routes: 'tests/fixtures/site/src/routes', serverTiming: true })

    expect((await timed.handle(new Request('http://localhost/'))).headers.get('server-timing')).toMatch(/^load-0;desc="tests\/fixtures\/site\/src\/routes\/_layout\.kay";dur=\d+\.\d, load-1;desc="tests\/fixtures\/site\/src\/routes\/index\.kay";dur=\d+\.\d, render;dur=\d+\.\d$/)
  })

  it('hands a tracer a span per page request with one per load and the render in it', async () => {
    const { tracer, ended } = recordingTracer()
    const traced = await pages({ routes: 'tests/fixtures/site/src/routes', tracer })

    const home = await traced.handle(new Request('http://localhost/'))

    expect(home.status).toBe(200)
    expect(ended.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'GET /', parent: undefined, kind: 1, attributes: { 'http.request.method': 'GET', 'http.route': '/', 'url.path': '/', 'kay.request.id': home.headers.get('x-request-id'), 'http.response.status_code': 200 } },
      { name: 'kay.load tests/fixtures/site/src/routes/_layout.kay', parent: 'GET /', kind: undefined, attributes: {} },
      { name: 'kay.load tests/fixtures/site/src/routes/index.kay', parent: 'GET /', kind: undefined, attributes: {} },
      { name: 'kay.render tests/fixtures/site/src/routes/index.kay', parent: 'GET /', kind: undefined, attributes: {} },
    ])
  })

  it('marks a span whose load threw, and the request it failed', async () => {
    const { tracer, ended } = recordingTracer()
    const traced = await pages({ routes: 'tests/fixtures/site/src/routes', tracer })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      expect((await traced.handle(new Request('http://localhost/boom?fail'))).status).toBe(500)
      expect(ended.filter(span => span.status === 2).map(span => span.name).sort()).toEqual(['GET /boom', 'kay.load tests/fixtures/site/src/routes/boom.kay'])
    }
    finally {
      logged.mockRestore()
    }
  })

  it('leaves a span ended by a redirect or a 404 unmarked, as the app meant it', async () => {
    const { tracer, ended } = recordingTracer()
    const traced = await pages({ routes: 'tests/fixtures/site/src/routes', tracer })

    expect((await traced.handle(new Request('http://localhost/todos/abc'))).status).toBe(302)
    expect((await traced.handle(new Request('http://localhost/todos/999'))).status).toBe(404)
    expect(ended.map(span => span.name)).toContain('kay.load tests/fixtures/site/src/routes/todos/[id].kay')
    expect(ended.filter(span => span.status !== undefined)).toEqual([])
  })

  it('hands it a span per action call', async () => {
    const { tracer, ended } = recordingTracer()
    const traced = await pages({ routes: 'tests/fixtures/bare/src/routes', prebuilt: true, tracer })
    const url = '/_kay/action/tests/fixtures/bare/src/routes/survey.kay/answer'
    const response = await traced.handle(new Request(`http://localhost${url}`, { method: 'POST', headers: { referer: 'http://localhost/survey' }, body: new URLSearchParams('tags=a&count=3') }))

    expect(response.status).toBe(303)
    expect(ended).toEqual([{ name: `POST ${url}`, parent: undefined, kind: 1, attributes: { 'http.request.method': 'POST', 'http.route': url, 'url.path': url, 'kay.request.id': response.headers.get('x-request-id'), 'http.response.status_code': 303 } }])
  })

  it('hands it a span per API request too, requests logged or not', async () => {
    const lines = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      for (const log of [false, true]) {
        const { tracer, ended } = recordingTracer()
        const traced = await pages({ routes: 'tests/fixtures/production/src/routes', api: 'tests/fixtures/production/src/api', prebuilt: false, tracer, log })

        expect(await (await traced.handle(new Request('http://localhost/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' }))).text()).toBe('5')
        // Elysia runs the hook ending it once the response is out.
        await new Promise(resolve => setTimeout(resolve, 10))
        expect(ended).toEqual([{ name: 'POST /api/echo', parent: undefined, kind: 1, attributes: { 'http.request.method': 'POST', 'http.route': '/api/echo', 'url.path': '/api/echo', 'kay.request.id': expect.any(String), 'http.response.status_code': 200 } }])
      }
    }
    finally {
      lines.mockRestore()
    }
  })
})

describe('action input', () => {
  const SURVEY = 'http://localhost/_kay/action/tests/fixtures/bare/src/routes/survey.kay'
  const post = async (name: string, body: URLSearchParams | FormData | string, headers: Record<string, string> = {}) => bare.handle(new Request(`${SURVEY}/${name}`, { method: 'POST', headers: { referer: 'http://localhost/survey', ...headers }, body }))
  const answered = async (body: URLSearchParams | FormData) => {
    const response = await post('answer', body)

    return { status: response.status, answer: JSON.parse(response.headers.get('x-answer') ?? 'null') as unknown }
  }

  it('reads a plain form against the schema: arrays, numbers, booleans and blank optional fields', async () => {
    expect(await answered(new URLSearchParams('tags=a&count=3&agree=on&age=&email=&note='))).toEqual({ status: 303, answer: { tags: ['a'], count: 3, agree: true } })
    expect(await answered(new URLSearchParams('tags=a&tags=b&scores=1&scores=2.5&count=0&age=41'))).toEqual({ status: 303, answer: { tags: ['a', 'b'], scores: [1, 2.5], count: 0, agree: false, age: 41 } })
    expect(await answered(new URLSearchParams('count=1&agree=false'))).toEqual({ status: 303, answer: { tags: [], count: 1, agree: false } })

    const form = new FormData()

    form.append('tags', 'only')
    form.append('count', '7')
    form.append('agree', 'true')
    expect(await answered(form)).toEqual({ status: 303, answer: { tags: ['only'], count: 7, agree: true } })

    const noPhoto = new FormData()

    noPhoto.append('photos', new File([], ''))
    expect((await post('gallery', noPhoto)).status).toBe(422)

    for (const count of ['0x10', '0b11', '0o7', 'Infinity', '1_000'])
      expect(await answered(new URLSearchParams(`count=${count}&agree=on`))).toEqual({ status: 422, answer: null })

    expect(await answered(new URLSearchParams('count=1e3&agree=on&age=-.5'))).toEqual({ status: 303, answer: { tags: [], count: 1000, agree: true, age: -0.5 } })

    const refused = await post('answer', new URLSearchParams('tags=a&count=1.5&agree=on&age=old'))

    expect(refused.status).toBe(422)
    expect(refused.headers.get('x-answer')).toBeNull()
    expect(await refused.text()).toContain('<p>Survey</p>')
  })

  it('answers a call returning nothing with an empty body, and a redirect holding a line break as a server error', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const call = await post('nothing', stringify({}), { 'content-type': 'application/json', 'x-kay-action': '1' })

      expect(call.status).toBe(200)
      expect(await call.text()).toBe('')

      const away = await post('away', stringify({ to: '/x\r\nset-cookie: a=b' }), { 'content-type': 'application/json', 'x-kay-action': '1' })

      expect(away.status).toBe(500)
      expect(parse(await away.text())).toEqual({ errors: { '': 'Something went wrong on our side; try again later' }, data: undefined })
      expect((await bare.handle(new Request(`http://localhost/?next=${encodeURIComponent('/x\r\nset-cookie: a=b')}`))).status).toBe(500)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('holds a line break'))

      // Nor a NUL, which Bun refuses with its own message, nor a scheme a call would run as script.
      for (const to of ['/a\0b', 'javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x']) {
        const refused = await post('away', stringify({ to }), { 'content-type': 'application/json', 'x-kay-action': '1' })

        expect([refused.status, (parse(await refused.text()) as { errors: Record<string, string> }).errors['']]).toEqual([500, 'Something went wrong on our side; try again later'])
      }

      expect((await post('away', stringify({ to: 'https://example.com/x' }), { 'content-type': 'application/json', 'x-kay-action': '1' })).headers.get('x-kay-redirect')).toBe('https://example.com/x')
    }
    finally {
      logged.mockRestore()
    }
  })

  it('fails a call with the status ctx.fail gives, refusing one that is no error status', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const fail = async (status: number) => post('fails', stringify({ status }), { 'content-type': 'application/json', 'x-kay-action': '1' })

    try {
      expect((await fail(418)).status).toBe(418)
      expect((await fail(200)).status).toBe(500)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('ctx.fail takes an error status, from 400 to 599, not 200'))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('percent-encodes a redirect to a path holding characters a header cannot carry', async () => {
    const away = await post('away', stringify({ to: '/blog/日本語' }), { 'content-type': 'application/json', 'x-kay-action': '1' })
    const page = await bare.handle(new Request(`http://localhost/?next=${encodeURIComponent('/blog/日本語?q=é%20x')}`))

    expect(away.headers.get('x-kay-redirect')).toBe('/blog/%E6%97%A5%E6%9C%AC%E8%AA%9E')
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/blog/%E6%97%A5%E6%9C%AC%E8%AA%9E?q=%C3%A9%20x')
  })

  it('serves the actions layouts export, behind the guards of their directory', async () => {
    const root = process.cwd()
    const dir = await mkdtemp(join(root, '.kay/routes-'))
    const id = dir.slice(root.length + 1)
    const action = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const leave = action(t.Object({}), () => \'left\')\n---\nslot\n'

    try {
      await Bun.write(join(dir, '_layout.kay'), action)
      await Bun.write(join(dir, 'index.kay'), 'p Home\n')
      await Bun.write(join(dir, 'inner/_layout.kay'), action)
      await Bun.write(join(dir, 'inner/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403, \'Inner only\'))\n')
      await Bun.write(join(dir, 'inner/index.kay'), 'p Inner\n')

      const served = await pages({ routes: dir, prebuilt: true })
      const call = async (file: string) => {
        const response = await served.handle(new Request(`http://localhost/_kay/action/${id}/${file}/leave`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({}) }))

        return `${response.status} ${await response.text()}`
      }

      expect(await call('_layout.kay')).toBe('200 ["left"]')
      expect(await call('inner/_layout.kay')).toBe('403 Inner only')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to boot when two files would serve one action URL', async () => {
    const root = process.cwd()
    const dir = await mkdtemp(join(root, '.kay/routes-'))
    const action = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const go = action(t.Object({}), () => 1)\n---\np Go\n'

    try {
      await Bun.write(join(dir, 'a b.kay'), action)
      await Bun.write(join(dir, 'a_b.kay'), action)
      await expect(pages({ routes: dir, prebuilt: true })).rejects.toThrow(`kay: ${join(dir, 'a b.kay')} and ${join(dir, 'a_b.kay')} both export an action served at /_kay/action/${dir.slice(root.length + 1)}/a_b.kay/go; rename one of the files`)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never echoes a field named like a secret, matching words rather than letters', () => {
    const fields = { cvv2: 'x', cardcvc: 'x', userpass: 'x', pin2: 'x', password: 'x', newPassword: 'x', user_passcode: 'x', apiKey: 'x', APIKey: 'x', pin: 'x', cardNumber: 'x', otp: 'x', csrfToken: 'x', passenger: 'Ada', spinner: 's', shipping: 'post', email: 'a@b.c' }

    expect(submittedValues(fields)).toEqual({ passenger: 'Ada', spinner: 's', shipping: 'post', email: 'a@b.c' })
  })
})
