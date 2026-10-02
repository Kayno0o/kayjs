import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { pages } from '../src/server'
import { auth } from './fixtures/site/src/auth'

const app = await pages({ routes: 'tests/fixtures/site/src/routes' })
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
  // A guard registered before the pages covers their actions too, which a layout's load never runs for.
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

describe('special pages', () => {
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
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ message: 'Kaboom' }))
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
      expect(html).toContain('<pre class="stack">Error: Kaboom')
    }
    finally {
      logged.mockRestore()
    }
  })
})
