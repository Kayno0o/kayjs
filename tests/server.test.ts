import type { ClientManifest } from '../src/server/client'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { ActionError } from '../src/runtime'
import { inlineScriptHashes, pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { submittedValues, writeFlash } from '../src/server/flash'
import { prerenderPages } from '../src/server/prerender'
import { renderPage } from '../src/server/render'
import { scanRoutes } from '../src/server/routes'
import { speculationRules } from '../src/server/speculation'
import { auth } from './fixtures/site/src/auth'
import { resetTodos } from './fixtures/site/src/data'

const app = await pages({ routes: 'tests/fixtures/site/src/routes', publicDir: 'tests/fixtures/site/public' })
// No _404.kay nor _error.kay: failures answer in plain text.
const bare = await pages({ routes: 'tests/fixtures/bare/src/routes', prebuilt: true })
const MARKERS = /<!--[$/]-->/g
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/
const ENTRY = /<script type="module" (?:async )?src="\/_kay\/([^"]+)"><\/script>/
const BODY = /<body>([\s\S]*)<\/body>/
// Any script but the speculation rules, which hold no code.
const SCRIPT = /<script(?! type="speculationrules")/
const INLINE_SCRIPTS = /<script>([\s\S]*?)<\/script>/g
const EVERY_INLINE_SCRIPT = /<script(?: type="speculationrules")?>([\s\S]*?)<\/script>/g
const SPECULATION = /<script type="speculationrules">(.*?)<\/script>/
// happy-dom swaps in its own Request, which Elysia cannot read headers from.
const NativeRequest = Request

interface ClientEntry {
  ready: Promise<void>
  hydrate: (root?: ParentNode) => Promise<void>
}

let hydrated = false

// The entry hydrates the document it loads in; a module is evaluated once per process, so later documents go through its `hydrate`.
async function hydrateFrom(html: string): Promise<void> {
  const entry = await import(join(process.cwd(), '.kay/client/dist', ENTRY.exec(html)![1]!)) as ClientEntry

  await (hydrated ? entry.hydrate() : entry.ready)
  hydrated = true
}

// `name=value` of the cookie a response sets, without its attributes.
function cookiePair(response: Response): string {
  const header = response.headers.get('set-cookie')!

  return header.slice(0, header.indexOf(';'))
}

async function get(path: string): Promise<{ status: number, html: string, headers: Headers }> {
  const response = await app.handle(new Request(`http://localhost${path}`))

  return { status: response.status, html: (await response.text()).replace(MARKERS, ''), headers: response.headers }
}

afterAll(resetTodos)

describe('pages', () => {
  it('renders a page inside its layout with server data typed into the template', async () => {
    const { status, html, headers } = await get('/')

    expect(status).toBe(200)
    expect(headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(html).toStartWith('<!doctype html><html lang="en"><head>')
    expect(html).toContain('<header><a href="/">Kay demo</a></header><main>')
    expect(html).toContain('<article class="card"><h2>Todos</h2><p>1 open</p><ul>')
    expect(html).toContain('<li><a href="/todos/2">Serve pages</a></li>')
  })

  it('ships the hydration script and the island bundle only to pages with islands', async () => {
    const home = await get('/')

    expect(home.html).toContain('<kay-island data-component="tests/fixtures/site/src/components/counter.kay"')
    expect(home.html).toContain('window._$HY')
    expect(home.html).toMatch(/<kay-island [^>]+><button _hk=k\w+-0 class="counter">/)
    expect(home.html.replace(/<kay-island[\s\S]*<\/kay-island>/, '')).not.toContain('_hk=')
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

    expect(about).toStartWith('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="description"')
    expect(about.match(/name="viewport"/g)).toHaveLength(1)
    expect(about).toContain('<meta name="viewport" content="width=device-width" data-dh="meta:name:viewport">')
    expect(home).toContain('<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">')
    expect(about).toContain('<title data-dh="title">About</title>')
    expect(about.match(/name="description"/g)).toHaveLength(1)
    expect(about).toContain('content="What this site is"')
    expect(home).toContain('<title data-dh="title">Kay demo</title>')
    expect(home).toContain('content="Kay demo, a site of todos"')
  })

  it('preloads the chunks of the islands a page renders, from a manifest a prebuilt server reads', async () => {
    const manifestFile = Bun.file(join(process.cwd(), '.kay/client/manifest.json'))
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

  it('links the stylesheets the layouts and the page import, through components, islands and modules', async () => {
    const home = (await get('/')).html
    const links = [...home.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1]!)
    const [layout, page] = await Promise.all(links.map(async link => (await app.handle(new Request(`http://localhost${link}`))).text()))

    expect(links).toHaveLength(2)
    expect(layout).toContain('background: url("/paper.png")')
    expect(page).toContain('.card {')
    expect(page).toContain('.counter {')
    expect((await get('/about')).html).toContain(`<link rel="stylesheet" href="${links[0]}"><script type="speculationrules">`)
    expect((await Bun.file(join(process.cwd(), '.kay/classes.txt')).text()).split('\n')).toEqual(expect.arrayContaining(['card', 'counter']))
  })

  it('ships the entry to a page whose islands all wait, without preloading their chunks', async () => {
    const manifest = await Bun.file(join(process.cwd(), '.kay/client/manifest.json')).json() as ClientManifest
    const { html } = await get('/lazy')

    expect(html).toContain('data-hydrate="idle"')
    expect(html).toContain(`<script type="module" src="${manifest.entry}"></script>`)
    expect(html).not.toContain(manifest.islands['tests/fixtures/site/src/components/counter.kay']![0])
  })

  it('serves the files components import at one content-hashed URL, the same on the server and in islands', async () => {
    const manifest = await Bun.file(join(process.cwd(), '.kay/client/manifest.json')).json() as ClientManifest
    const { html } = await get('/assets')
    const logo = (/<img class="static" src="([^"]+)"/).exec(html)![1]!
    const response = await app.handle(new Request(`http://localhost${logo}`))
    const chunk = await app.handle(new Request(`http://localhost${manifest.islands['tests/fixtures/site/src/components/brand.kay']![0]}`))

    expect(logo).toMatch(/^\/_kay\/assets\/logo-\w+\.png$/)
    expect(html).toContain(`class="brand" src="${logo}"`)
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

  it('ships Solid\'s production build, not its development one', async () => {
    const dist = join(process.cwd(), '.kay/client/dist')
    const chunks = await Promise.all((await readdir(dist)).filter(file => file.endsWith('.js')).map(async file => Bun.file(join(dist, file)).text()))

    // Only solid-js's dev build points at its diagnostics package.
    expect(chunks.filter(chunk => chunk.includes('@solidjs/diagnostics'))).toEqual([])
  })

  it('hydrates the island on the served page and leaves the static markup alone', async () => {
    const html = await (await app.handle(new Request('http://localhost/'))).text()

    GlobalRegistrator.register()

    try {
      // Solid's bootstrap assigns `_$HY` on globalThis, which outlives happy-dom's window between test files.
      delete (globalThis as { _$HY?: unknown })._$HY
      // eslint-disable-next-line no-new-func -- runs Solid's inline bootstrap script, which happy-dom does not execute from markup
      new Function(INLINE_SCRIPT.exec(html)![1]!)()
      document.body.innerHTML = BODY.exec(html)![1]!
      const button = document.querySelector('kay-island button')!
      const card = document.querySelector('article.card')!

      await hydrateFrom(html)
      expect(document.querySelector('kay-island button')).toBe(button)
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
    const post = (headers: Record<string, string>) => app.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/index.kay/add', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ title: 'Elsewhere' }),
    }))

    expect((await post({ origin: 'https://evil.example' })).status).toBe(403)
    expect((await post({ origin: 'https://localhost' })).status).toBe(303)
    expect((await post({ referer: 'https://evil.example/' })).headers.get('location')).toBe('/')
  })

  it('answers a fetch call with the result and rejects input the schema refuses', async () => {
    const call = (body: unknown) => app.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/index.kay/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1' },
      body: JSON.stringify(body),
    }))
    const created = await call({ title: 'From fetch' })

    expect(created.status).toBe(200)
    expect(typeof await created.json()).toBe('number')
    expect((await call({ title: '' })).status).toBe(422)
    expect((await call({})).status).toBe(422)
  })

  it('lets an island call a page action through its browser stub', async () => {
    const html = await (await app.handle(new Request('http://localhost/new'))).text()
    const realFetch = globalThis.fetch

    GlobalRegistrator.register()
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => app.handle(new NativeRequest(new URL(String(input), 'http://localhost'), init))) as typeof fetch

    try {
      delete (globalThis as { _$HY?: unknown })._$HY
      // eslint-disable-next-line no-new-func -- runs Solid's inline bootstrap script, which happy-dom does not execute from markup
      new Function(INLINE_SCRIPT.exec(html)![1]!)()
      document.body.innerHTML = BODY.exec(html)![1]!
      await hydrateFrom(html)
      const input = document.querySelector<HTMLInputElement>('form.quick input')!

      input.value = 'From an island'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // Solid 2 stages writes until a microtask; a person types and submits in separate tasks.
      await new Promise(resolve => setTimeout(resolve, 0))
      document.querySelector('form.quick')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
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
  const request = (path: string, init: RequestInit = {}) => guarded.handle(new Request(`http://localhost${path}`, init))

  it('passes what the app derives to pages as ctx.locals, behind its guard', async () => {
    expect((await request('/account')).status).toBe(401)
    expect(await (await request('/account', { headers: { 'x-user': 'ada' } })).text()).toContain('<p class="user">ada</p>')
  })

  it('passes ctx.locals to actions behind the same guard and sends the cookies they set', async () => {
    const post = (headers: Record<string, string>) => guarded.handle(new Request(ACCOUNT_ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', ...headers },
      body: JSON.stringify({ theme: 'dark' }),
    }))
    const refused = await post({})
    const accepted = await post({ 'x-user': 'ada' })

    expect(refused.status).toBe(401)
    expect(await accepted.json()).toBe('ada')
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

describe('guards', () => {
  const PROMOTE = 'http://localhost/_kay/action/tests/fixtures/site/src/routes/admin/index.kay/promote'
  const signedIn = new Elysia().use(auth).use(app)
  const visit = (user?: string) => signedIn.handle(new NativeRequest('http://localhost/admin', { headers: user === undefined ? {} : { 'x-user': user } }))
  const promote = (body: unknown, headers: Record<string, string> = {}) => signedIn.handle(new NativeRequest(PROMOTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kay-action': '1', ...headers },
    body: JSON.stringify(body),
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

    expect(await done.json()).toBe('bob is an admin')
    expect(done.headers.get('set-cookie')).toStartWith('seen=admin;')
  })

  it('sees what the app resolves, on pages and actions alike', async () => {
    const resolved = new Elysia().resolve({ as: 'global' }, ({ headers }) => ({ user: headers['x-user'] })).use(app)
    const page = await resolved.handle(new NativeRequest('http://localhost/admin', { headers: { 'x-user': 'ada' } }))
    const action = await resolved.handle(new NativeRequest(PROMOTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-user': 'ada' },
      body: JSON.stringify({ name: 'bob' }),
    }))

    expect(page.status).toBe(200)
    expect(await action.json()).toBe('bob is an admin')
  })

  it('refuses a cross-site post before any guard runs', async () => {
    const response = await promote({ name: 'bob' }, { 'x-user': 'ada', 'origin': 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})

describe('await blocks', () => {
  async function chunksOf(path: string): Promise<string[]> {
    const response = await app.handle(new Request(`http://localhost${path}`))
    const decoder = new TextDecoder()
    const chunks: string[] = []

    expect(response.status).toBe(200)
    for await (const chunk of response.body!)
      chunks.push(decoder.decode(chunk))

    return chunks
  }

  it('sends the page at once, then each pending block as it settles', async () => {
    const [page, failed, ready, end] = await chunksOf('/feed?delay=30')

    expect(page).toContain('<h1>Feed</h1><!--kay-await:')
    expect(page).toContain('<p class="pending">Loading the feed</p>')
    expect(page).toContain('<p class="now">right away</p></main>')
    expect(page).not.toContain('Feed down')
    expect(failed).toContain('<p class="error">Feed down</p></template>')
    expect(ready).toContain('<ul><li>first</li><li>second</li></ul><kay-island')
    expect(ready).toContain('<script type="module" async src="/_kay/')
    expect(end).toBe('</body></html>')
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

    GlobalRegistrator.register()

    try {
      delete (globalThis as { _$HY?: unknown })._$HY
      document.body.innerHTML = BODY.exec(html)![1]!
      // Runs the inline scripts in page order, as the browser does while the stream arrives; declarations must land on the global scope.
      for (const [, script] of html.matchAll(INLINE_SCRIPTS))
        // eslint-disable-next-line no-eval -- happy-dom does not execute scripts from markup
        (0, eval)(script!)
      await hydrateFrom(html)

      expect(document.querySelector('.pending')).toBeNull()
      expect(document.querySelector('template')).toBeNull()
      expect([...document.querySelectorAll('main > *')].map(element => element.tagName.toLowerCase())).toEqual(['h1', 'ul', 'kay-island', 'p', 'p'])
      expect(document.querySelector('p.error')?.textContent).toBe('Feed down')
      const button = document.querySelector('kay-island button')!

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
      expect(await prerenderPages(root, { routes }, (await readClient(root))!)).toBe(3)
      const file = await Bun.file(join(root, '.kay/client/pages/admin/report.html')).text()
      const signedIn = new Elysia().use(auth).use(await pages({ routes, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const visit = (user: string, headers: Record<string, string> = {}) => signedIn.handle(new NativeRequest('http://localhost/admin/report', { headers: { 'x-user': user, ...headers } }))
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
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('renders a dynamic route for each params its prerender export lists, and the others per request', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      await prerenderPages(root, { routes }, (await readClient(root))!)
      const served = new Elysia().use(await pages({ routes, publicDir: 'tests/fixtures/site/public', prebuilt: true }))
      const visit = async (path: string) => {
        const response = await served.handle(new NativeRequest(`http://localhost${path}`))

        return { html: (await response.text()).replace(MARKERS, ''), etag: response.headers.get('etag') }
      }

      expect(await Bun.file(join(root, '.kay/client/pages/docs/guide/intro.html')).text()).toBe((await get('/docs/guide/intro')).html.replace('guide/intro', '<!--$-->guide/intro<!--/-->'))
      expect(await Bun.file(join(root, '.kay/client/pages/docs/a%20b.html')).exists()).toBe(true)
      expect(await visit('/docs/guide/intro')).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at guide/intro</p>'), etag: expect.any(String) })
      expect(await visit('/docs/a%20b')).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at a b</p>'), etag: expect.any(String) })
      expect(await visit('/docs/other')).toMatchObject({ html: expect.stringContaining('<p class="path">Docs at other</p>'), etag: null })
    }
    finally {
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('asks a dynamic route marked prerender = true for the params to render', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!
    const dir = await mkdtemp(join(root, '.kay/routes-'))

    try {
      await Bun.write(join(dir, 'posts/[slug].kay'), '--- server\nexport const prerender = true\n---\np {ctx.params.slug}\n')
      await expect(prerenderPages(root, { routes: dir }, (await readClient(root))!)).rejects.toThrow('so `prerender` lists them: export const prerender = [{ slug: \'...\' }]')
      await rm(join(dir, 'posts'), { recursive: true })
      // Another file, since the first one stays in the module cache.
      await Bun.write(join(dir, 'tags/[slug].kay'), '--- server\nexport const prerender = [{ slug: 1 }]\n---\np {ctx.params.slug}\n')
      await expect(prerenderPages(root, { routes: dir }, (await readClient(root))!)).rejects.toThrow('prerenders {"slug":1}, which needs a string for each of slug')
      await rm(join(dir, 'tags'), { recursive: true })
      await Bun.write(join(dir, 'files/[...path].kay'), '--- server\nexport const prerender = [{ path: \'a/../../x\' }]\n---\np {ctx.params.path}\n')
      await expect(prerenderPages(root, { routes: dir }, (await readClient(root))!)).rejects.toThrow('with no empty, . or .. segment')
      await rm(join(dir, 'files'), { recursive: true })
      await Bun.write(join(dir, 'notes/[slug].kay'), '--- server\nexport const prerender = \'yes\'\n---\np {ctx.params.slug}\n')
      await expect(prerenderPages(root, { routes: dir }, (await readClient(root))!)).rejects.toThrow('exports a prerender that is neither true, false')
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
      await Bun.write(join(dir, 'index.kay'), '--- server\nexport const prerender = true\n---\np Home\n')
      await Bun.write(join(dir, '[slug].kay'), '--- server\nexport const prerender = [{ slug: \'index\' }]\nconst slug = ctx.params.slug\n---\np {slug}\n')
      await expect(prerenderPages(root, { routes: dir }, (await readClient(root))!)).rejects.toThrow('kay: /index and / would both be prerendered to index.html')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
      await rm(join(root, '.kay/client/pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('refuses to prerender a page that reads what only a request carries', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const account = (await scanRoutes(join(process.cwd(), routes))).find(route => route.pattern === '/account')!
      const response = await renderPage({ ...account, guards: [] }, { request: new Request('http://localhost/account'), params: {} }, (await readClient(process.cwd()))!, { prerendering: true })

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
    const { text } = await visit(`/?title=${encodeURIComponent('data-dh="charset" data-dh="meta:name:viewport"')}`)

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

        await scanRoutes(dir)

        return 'scanned'
      }
      catch (error) {
        return (error as Error).message.replaceAll(dir, '<routes>')
      }
      finally {
        await rm(dir, { recursive: true, force: true })
      }
    }

    expect(await clash(['about.kay', 'about/index.kay'])).toBe('kay: <routes>/about.kay and <routes>/about/index.kay both serve /about')
    expect(await clash(['todos/[id].kay', 'todos/[slug].kay'])).toBe('kay: <routes>/todos/[id].kay and <routes>/todos/[slug].kay both serve /todos/:id')
    expect(await clash(['u/[id]/a.kay', 'u/[slug]/b.kay'])).toBe('kay: <routes>/u/[id]/a.kay and <routes>/u/[slug]/b.kay name the same segment :id and :slug; give it one name')
    expect(await clash(['x:y.kay'])).toBe('kay: <routes>/x:y.kay has a :, * or \' in its name, which the router cannot serve; rename it')
    expect(await clash(['it\'s.kay'])).toBe('kay: <routes>/it\'s.kay has a :, * or \' in its name, which the router cannot serve; rename it')
    expect(await clash(['todos/[id].kay', 'todos/new.kay', 'docs/[...path].kay', 'docs/index.kay', 'a b.kay'])).toBe('scanned')
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
  const postForm = (title: string) => app.handle(new Request(ADD, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/' },
    body: new URLSearchParams({ title, password: 'hunter2' }),
  }))
  // What the browser does with the redirect: back to the page, sending the cookie it was just given.
  const followed = async (response: Response) => {
    const cookie = cookiePair(response)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('http://localhost/')

    return app.handle(new Request('http://localhost/', { headers: { cookie } }))
  }

  it('shows a plain form what the schema refused, with the values it posted, once', async () => {
    const page = await followed(await postForm(''))
    const html = await page.text()

    expect(html).toContain('<input name="title" placeholder="New todo" value="">')
    expect(html).toContain('<p class="error">Write a title</p>')
    expect(page.headers.get('set-cookie')).toStartWith('kay_failed=;')
    expect((await get('/')).html).not.toContain('class="error"')
  })

  it('shows a plain form what the handler passed to ctx.fail, never echoing a secret field', async () => {
    const response = await postForm('Serve pages')
    const pair = cookiePair(response)
    const flash = pair.slice(pair.indexOf('=') + 1)
    const html = await (await followed(response)).text()

    expect(html).toContain('value="Serve pages"')
    expect(html).toContain('<p class="error">Already on the list</p>')
    expect(Buffer.from(flash, 'base64url').toString()).not.toContain('hunter2')
  })

  it('answers a call with the failure as JSON', async () => {
    const call = (title: string) => app.handle(new Request(ADD, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: JSON.stringify({ title }) }))
    const refused = await call('')
    const duplicate = await call('Serve pages')

    expect(refused.status).toBe(422)
    expect(await refused.json()).toEqual({ errors: { title: 'Write a title' }, data: null })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ errors: {}, data: { message: 'Already on the list' } })
  })

  it('rejects a call from the browser with an ActionError carrying the failure', async () => {
    const { add } = await import(join(import.meta.dir, 'fixtures/site/src/routes/index.kay')) as { add: (input: { title: string }) => Promise<number> }
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
  })

  it('ignores a forged failure cookie', async () => {
    const page = await app.handle(new Request('http://localhost/', { headers: { cookie: 'kay_failed=not-json' } }))

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
    expect((await app.handle(new Request('http://localhost/robots.txt', { headers: { 'if-none-match': etag } }))).status).toBe(304)
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

describe('special pages', () => {
  it('answers a failing action with a generic 500 and logs its stack at the .kay line', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const response = await app.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/boom.kay/explode', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-kay-action': '1' },
        body: '{}',
      }))

      expect(response.status).toBe(500)
      expect(await response.text()).toBe('Internal Server Error')
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^Error: Kaboom in an action\n\s+at \S+ \(\S+\/boom\.kay:6:13\)/))
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
      expect((await watched.handle(new Request('http://localhost/_kay/action/tests/fixtures/site/src/routes/boom.kay/explode', { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: '{}' }))).status).toBe(500)
      expect(await (await watched.handle(new Request('http://localhost/boom?later'))).text()).not.toContain('Kaboom')
      expect(await (await watched.handle(new Request('http://localhost/boom'))).text()).toContain('<p>Fine</p>')
      expect(reported).toEqual(['/boom?fail: Kaboom', '/_kay/action/tests/fixtures/site/src/routes/boom.kay/explode: Kaboom in an action', '/boom?later: Kaboom later'])
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^Error: Tracker down/))
    }
    finally {
      logged.mockRestore()
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
      expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^Error: Kaboom\n\s+at load \(\S+\/boom\.kay:10:13\)/))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('shows the message and the stack in development, and times each load', async () => {
    const dev = await pages({ routes: 'tests/fixtures/site/src/routes', dev: true })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const html = await (await dev.handle(new Request('http://localhost/boom?fail'))).text()

      expect(html).toContain('<p class="message">Kaboom</p>')
      expect(html).toMatch(/<pre class="stack">Error: Kaboom\n\s+at load \(\S+\/boom\.kay:10:13\)/)
      expect(html).toContain('new EventSource("/_kay/dev/events")')
      expect((await dev.handle(new Request('http://localhost/_kay/dev/events'))).headers.get('content-type')).toBe('text/event-stream')

      const timing = (await dev.handle(new Request('http://localhost/'))).headers.get('server-timing')

      expect(timing).toMatch(/^load-0;desc="tests\/fixtures\/site\/src\/routes\/_layout\.kay";dur=\d+\.\d, load-1;desc="tests\/fixtures\/site\/src\/routes\/index\.kay";dur=\d+\.\d, render;dur=\d+\.\d$/)
      expect((await get('/')).headers.get('server-timing')).toBeNull()
    }
    finally {
      logged.mockRestore()
    }
  })
})

describe('action input', () => {
  const SURVEY = 'http://localhost/_kay/action/tests/fixtures/bare/src/routes/survey.kay'
  const post = (name: string, body: URLSearchParams | FormData | string, headers: Record<string, string> = {}) => bare.handle(new Request(`${SURVEY}/${name}`, { method: 'POST', headers: { referer: 'http://localhost/survey', ...headers }, body }))
  const answered = async (body: URLSearchParams | FormData) => {
    const response = await post('answer', body)

    return { status: response.status, answer: JSON.parse(response.headers.get('x-answer') ?? 'null') as unknown }
  }

  it('reads a plain form against the schema: arrays, numbers, booleans and blank optional fields', async () => {
    expect(await answered(new URLSearchParams('tags=a&count=3&agree=on&age=&email=&note='))).toEqual({ status: 303, answer: { tags: ['a'], count: 3, agree: true, note: '' } })
    expect(await answered(new URLSearchParams('tags=a&tags=b&scores=1&scores=2.5&count=0&age=41'))).toEqual({ status: 303, answer: { tags: ['a', 'b'], scores: [1, 2.5], count: 0, agree: false, age: 41 } })
    expect(await answered(new URLSearchParams('count=1&agree=false'))).toEqual({ status: 303, answer: { tags: [], count: 1, agree: false } })

    const form = new FormData()

    form.append('tags', 'only')
    form.append('count', '7')
    form.append('agree', 'true')
    expect(await answered(form)).toEqual({ status: 303, answer: { tags: ['only'], count: 7, agree: true } })

    const refused = await post('answer', new URLSearchParams('tags=a&count=1.5&agree=on&age=old'))

    expect(refused.status).toBe(303)
    expect(refused.headers.get('x-answer')).toBeNull()
    expect(JSON.parse(Buffer.from(cookiePair(refused).slice('kay_failed='.length), 'base64url').toString())).toMatchObject({ status: 422, errors: { count: expect.any(String), age: expect.any(String) } })
  })

  it('answers a call returning nothing with an empty body, and a redirect holding a line break with a generic 500', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const call = await post('nothing', '{}', { 'content-type': 'application/json', 'x-kay-action': '1' })

      expect(call.status).toBe(200)
      expect(await call.text()).toBe('')

      const away = await post('away', JSON.stringify({ to: '/x\r\nset-cookie: a=b' }), { 'content-type': 'application/json', 'x-kay-action': '1' })

      expect(away.status).toBe(500)
      expect(await away.text()).toBe('Internal Server Error')
      expect((await bare.handle(new Request(`http://localhost/?next=${encodeURIComponent('/x\r\nset-cookie: a=b')}`))).status).toBe(500)
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('holds a line break'))
    }
    finally {
      logged.mockRestore()
    }
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
        const response = await served.handle(new Request(`http://localhost/_kay/action/${id}/${file}/leave`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: '{}' }))

        return `${response.status} ${await response.text()}`
      }

      expect(await call('_layout.kay')).toBe('200 "left"')
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
    const fields = { password: 'x', newPassword: 'x', user_passcode: 'x', apiKey: 'x', APIKey: 'x', pin: 'x', cardNumber: 'x', otp: 'x', csrfToken: 'x', passenger: 'Ada', spinner: 's', shipping: 'post', email: 'a@b.c' }

    expect(submittedValues(fields)).toEqual({ passenger: 'Ada', spinner: 's', shipping: 'post', email: 'a@b.c' })
  })

  it('warns when the failure data is too big for the cookie carrying it back', () => {
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)
    const cookies = new Bun.CookieMap()

    try {
      writeFlash(cookies, { action: '/_kay/action/x/go', status: 409, values: {}, errors: {}, data: { message: 'x'.repeat(4000) } })

      expect(cookies.has('kay_failed')).toBe(true)
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('/_kay/action/x/go'))
    }
    finally {
      warned.mockRestore()
    }
  })
})
