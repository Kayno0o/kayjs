import type { ClientManifest } from '../src/server/client'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { ActionError } from '../src/runtime'
import { pages } from '../src/server'
import { scanRoutes } from '../src/server/routes'
import { auth } from './fixtures/site/src/auth'

const app = await pages({ routes: 'tests/fixtures/site/src/routes', publicDir: 'tests/fixtures/site/public' })
const MARKERS = /<!--[$/]-->/g
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/
const ENTRY = /<script type="module" src="\/_kay\/([^"]+)"><\/script>/
const BODY = /<body>([\s\S]*)<\/body>/
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
    expect(about.html).not.toContain('<script')
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
    expect((await get('/about')).html).toContain(`<link rel="stylesheet" href="${links[0]}"></head>`)
    expect((await Bun.file(join(process.cwd(), '.kay/classes.txt')).text()).split('\n')).toEqual(expect.arrayContaining(['card', 'counter']))
  })

  it('ships the entry to a page whose islands all wait, without preloading their chunks', async () => {
    const manifest = await Bun.file(join(process.cwd(), '.kay/client/manifest.json')).json() as ClientManifest
    const { html } = await get('/lazy')

    expect(html).toContain('data-hydrate="idle"')
    expect(html).toContain(`<script type="module" src="${manifest.entry}"></script>`)
    expect(html).not.toContain(manifest.islands['tests/fixtures/site/src/components/counter.kay']![0])
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
  })

  it('refuses asset paths outside the client build or malformed', async () => {
    expect((await app.handle(new Request('http://localhost/_kay/..%2F..%2Fpackage.json'))).status).toBe(404)
    expect((await app.handle(new Request('http://localhost/_kay/%E0'))).status).toBe(404)
  })

  it('ships Solid\'s production build, not its development one', async () => {
    const dist = join(process.cwd(), '.kay/client/dist')
    const chunks = await Promise.all((await readdir(dist)).map(async file => Bun.file(join(dist, file)).text()))

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

  it('posts a plain form to its action and returns to the page', async () => {
    const home = await get('/')
    const form = (/<form class="add" action="([^"]+)" method="post"><input name="title"/).exec(home.html)

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

  it('guards the actions of its pages before their input is validated', async () => {
    const away = await promote({ name: '' })
    const denied = await promote({ name: 'bob' }, { 'x-user': 'bob' })

    expect(away.status).toBe(303)
    expect(away.headers.get('location')).toBe('/about')
    expect(denied.status).toBe(403)
    expect(await denied.text()).toBe('Admins only')
    expect((await promote({ name: '' }, { 'x-user': 'ada' })).status).toBe(422)

    const done = await promote({ name: 'bob' }, { 'x-user': 'ada' })

    expect(await done.json()).toBe('bob is an admin')
    expect(done.headers.get('set-cookie')).toStartWith('seen=admin;')
  })

  it('refuses a cross-site post before any guard runs', async () => {
    const response = await promote({ name: 'bob' }, { 'x-user': 'ada', 'origin': 'https://evil.example' })

    expect(response.status).toBe(403)
    expect(response.headers.get('set-cookie')).toBeNull()
  })
})

describe('route scan', () => {
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

  it('shows the message and the stack in development', async () => {
    const dev = await pages({ routes: 'tests/fixtures/site/src/routes', dev: true })
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const html = await (await dev.handle(new Request('http://localhost/boom?fail'))).text()

      expect(html).toContain('<p class="message">Kaboom</p>')
      expect(html).toMatch(/<pre class="stack">Error: Kaboom\n\s+at load \(\S+\/boom\.kay:10:13\)/)
      expect(html).toContain('new EventSource("/_kay/dev/events")')
      expect((await dev.handle(new Request('http://localhost/_kay/dev/events'))).headers.get('content-type')).toBe('text/event-stream')
    }
    finally {
      logged.mockRestore()
    }
  })
})
