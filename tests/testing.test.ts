import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { ActionError } from '../src/runtime'
import { readActionResponse } from '../src/runtime/action'
import { session } from '../src/server/session'
import { testSite } from '../src/test'
import { resetTodos } from './fixtures/site/src/data'

const routes = 'tests/fixtures/site/src/routes'
const MARKERS = /<!--[$/]-->/g
// A 1x1 PNG, which Elysia's `t.File({ type: 'image/png' })` recognises from its bytes.
const PNG = Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
const site = await testSite({ routes, publicDir: 'tests/fixtures/site/public', locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
// Imported once the site is up, which registers the `.kay` loader this process needs.
const { add } = await import(join(import.meta.dir, 'fixtures/site/src/routes/index.kay')) as { add: Action<{ title: string }, number> }
const { schedule, leak } = await import(join(import.meta.dir, 'fixtures/site/src/routes/events.kay')) as {
  schedule: Action<{ title: string, at: Date | string }, { title: string, at: Date, tags: Set<string>, seats: bigint }>
  leak: Action<Record<string, never>, unknown>
}

describe('kay/test', () => {
  afterAll(resetTodos)

  it('visits a page with the locals the test gives, following redirects', async () => {
    const home = await site.visit('/')
    const account = await site.visit('/account', { headers: { 'x-user': 'ada' } })
    const away = await site.visit('/admin')

    expect(home.status).toBe(200)
    expect(home.html).toContain('<h2>Todos</h2>')
    expect(home.html).not.toContain('<script type="module"')
    expect(account.html).toContain('<p class="user">ada</p>')
    expect(away).toMatchObject({ url: '/about', status: 200 })
    expect(site.cookies.get('seen')).toBe('admin')
  })

  it('serves the pages behind the app\'s plugins, so a session signs in, carries over and signs out', async () => {
    const signed = await testSite({ routes: 'tests/fixtures/session/src/routes', use: [session({ secret: 'a test secret of at least 32 characters' })], locals: () => ({ greeting: 'Hello' }) })
    const { signIn, signOut } = await import(join(import.meta.dir, 'fixtures/session/src/routes/index.kay')) as { signIn: Action<{ name: string }, unknown>, signOut: Action<Record<string, never>, unknown> }

    expect((await signed.submit(signIn, { name: '' })).html).toContain('<p class="error">Who are you?</p>')
    // `locals` adds to what the plugins derived, after them.
    expect((await signed.submit(signIn, { name: 'Ada' })).html).toContain('<p>Hello, signed in as Ada</p>')
    expect(signed.cookies.has('session')).toBe(true)
    expect((await signed.visit('/')).html).toContain('<p>Hello, signed in as Ada</p>')
    expect((await signed.submit(signOut, {})).html).toContain('<p>Hello, signed out</p>')
    expect(signed.cookies.has('session')).toBe(false)
  })

  it('calls an action with a form\'s fields, read as a form post reads them and answered as a call', async () => {
    const signed = await testSite({ routes: 'tests/fixtures/session/src/routes', use: [session({ secret: 'a test secret of at least 32 characters' })], locals: () => ({ greeting: 'Hello' }) })
    const { profile, signIn, signOut, limited } = await import(join(import.meta.dir, 'fixtures/session/src/routes/index.kay')) as { profile: Action<{ age: number, admin: boolean, tags: string[], rank?: number, avatar?: File }, unknown>, signIn: Action<{ name: string }, unknown>, signOut: Action<Record<string, never>, unknown>, limited: Action<Record<string, never>, unknown> }
    const form = (fields: [string, string | File][]) => {
      const data = new FormData()

      for (const [name, value] of fields)
        data.append(name, value)

      return data
    }

    // Coerced as a form post's fields are, the blank optional left out.
    expect(await signed.call(profile, form([['age', '36'], ['admin', 'on'], ['tags', 'a'], ['tags', 'b'], ['rank', ''], ['avatar', new File([], '')]]))).toEqual({ age: 36, admin: true, tags: ['a', 'b'] })
    expect(await signed.call(profile, form([['age', '1'], ['avatar', new File(['png'], 'me.png', { type: 'image/png' })]]))).toMatchObject({ avatar: 'me.png' })
    await expect(signed.call(profile, form([['age', 'old'], ['admin', 'on']]))).rejects.toMatchObject({ name: 'ActionError', status: 422, errors: { age: expect.any(String) } })
    // What the handler passed to ctx.fail, and no flash cookie: the island reads the answer itself.
    await expect(signed.call(signIn, form([['name', '']]))).rejects.toMatchObject({ status: 400, data: { error: 'Who are you?' } })
    expect(signed.cookies.has('kay_flash')).toBe(false)
    await expect(signed.call(signOut, form([]))).rejects.toMatchObject({ name: 'ActionRedirect', location: '/' })
    expect(await signed.call(limited, form([]))).toBe('ok')
    await expect(signed.call(limited, form([]))).rejects.toMatchObject({ status: 429 })
    // The honeypot catches a form's fields however they are sent.
    await expect(signed.call(profile, form([['age', '1'], ['website', 'spam']]))).rejects.toMatchObject({ status: 422, errors: { website: 'Leave this field empty' } })
  })

  it('stops at a redirect to another site', async () => {
    const bare = await testSite({ routes: 'tests/fixtures/bare/src/routes' })
    const away = await bare.visit(`/?next=${encodeURIComponent('https://example.com/about')}`)

    expect(away).toMatchObject({ url: '/?next=https%3A%2F%2Fexample.com%2Fabout', status: 302 })
    expect(away.headers.get('location')).toBe('https://example.com/about')
  })

  it('submits a form without JavaScript and lands back on the page with its failure', async () => {
    const failed = await site.submit(add, { title: '' }, { from: '/' })

    expect(failed.url).toBe('/')
    expect(failed.html).toContain('<p class="error">Write a title</p>')
    expect(site.cookies.has('kay_flash')).toBe(false)
    expect((await site.submit(add, { title: 'Tested without a server' })).html).toContain('Tested without a server</a></li>')
  })

  it('calls an action as an island does', async () => {
    const { promote } = await import(join(import.meta.dir, 'fixtures/site/src/routes/admin/index.kay')) as { promote: Action<{ name: string }, string> }

    expect(await site.call(add, { title: 'Called from a test' })).toBeNumber()
    await expect(site.call(add, { title: '' })).rejects.toThrow(ActionError)
    expect(await site.call(promote, { name: 'bob' }, { headers: { 'x-user': 'ada' } })).toBe('bob is an admin')
    await expect(site.call(promote, { name: 'bob' })).rejects.toMatchObject({ name: 'ActionRedirect', status: 303, location: '/about' })
  })

  it('uploads files from a form and from a call, nested ones included', async () => {
    const { upload } = await import(join(import.meta.dir, 'fixtures/site/src/routes/upload.kay')) as { upload: Action<{ note: string, file: File, attachment?: File, extra?: { copies: number, files: File[] } }, string> }
    const image = (name: string) => new File([PNG], name, { type: 'image/png' })
    // A browser posts a file input left empty as a nameless, empty file.
    const page = await site.submit(upload, { note: 'form', file: image('a.png'), attachment: new File([], '') }, { from: '/upload' })

    expect(page.url).toBe('/upload')
    expect(page.html).toContain(`form: ${PNG.length} bytes (a.png)</p>`)
    expect((await site.submit(upload, { note: 'attached', file: image('a.png'), attachment: new File(['x'], 'x.txt') }, { from: '/upload' })).html).toContain('attached x.txt</p>')
    expect((await site.submit(upload, { note: 'left out', file: image('a.png'), attachment: undefined }, { from: '/upload' })).html).toContain(`left out: ${PNG.length} bytes (a.png)</p>`)
    expect(await site.call(upload, { note: 'call', file: image('b.png'), extra: { copies: 2, files: [image('c.png'), new File(['notes'], 'd.txt')] } })).toBe(`call: ${PNG.length} bytes (b.png), 2 copies of 2 more`)
    expect(await site.call(upload, { note: 'blob', file: new Blob([PNG], { type: 'image/png' }) as File })).toBe(`blob: ${PNG.length} bytes (blob)`)
    await expect(site.call(upload, { note: 'not an image', file: new File(['{}'], 'e.png', { type: 'image/png' }) })).rejects.toMatchObject({ status: 422, errors: { file: 'Upload a PNG image' } })

    const refused = await site.submit(upload, { note: 'not an image', file: new File(['{}'], 'e.png', { type: 'image/png' }) }, { from: '/upload' })

    expect(refused.url).toBe('/upload')
    expect(refused.html).toContain('<p class="error">Upload a PNG image</p>')
    expect(refused.html).toContain('value="not an image"')

    const malformed = new FormData()

    malformed.set('$kay', '{not json')
    expect((await site.handle(new Request(`http://localhost${upload.url}`, { method: 'POST', headers: { 'x-kay-action': '1' }, body: malformed }))).status).toBe(400)
  })

  it('carries Dates, Sets and bigints both ways, in results and failure data, to calls and plain forms', async () => {
    const at = new Date(Date.UTC(2026, 9, 4, 10))
    const result = await site.call(schedule, { title: 'Launch', at })

    expect(result).toEqual({ title: 'Launch', at, tags: new Set(['new']), seats: 10n })
    await expect(site.call(schedule, { title: 'Old', at: new Date(0) })).rejects.toMatchObject({ status: 422, data: { earliest: new Date(Date.UTC(2000, 0, 1)) } })
    expect((await site.submit(schedule, { title: 'Old', at: '1990-01-01T00:00:00Z' }, { from: '/events' })).html.replace(MARKERS, '')).toContain('<p class="error">Not before 2000</p>')
  })

  it('shows the page what a plain form post that succeeded returned, once', async () => {
    const page = await site.submit(schedule, { title: 'Launch', at: '2026-10-04T10:00:00Z' }, { from: '/events' })

    expect(page.url).toBe('/events')
    expect(page.html.replace(MARKERS, '')).toContain('<p class="done">Scheduled Launch on 2026-10-04T10:00:00.000Z, 1 tag, 10 seats</p>')
    expect((await site.visit('/events')).html).not.toContain('class="done"')
  })

  it('answers a call whose result cannot reach the browser with a 500 naming what holds it, and still lands a plain form on its page', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(site.call(leak, {})).rejects.toMatchObject({ status: 500 })
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`kay: what ${leak.url} returned cannot reach the browser: Cannot stringify arbitrary non-POJOs at .format`))
      expect(await site.submit(leak, {}, { from: '/events' })).toMatchObject({ url: '/events', status: 200 })
      expect(warned).toHaveBeenCalledWith(expect.stringContaining(`kay: what ${leak.url} returned cannot reach the page through its cookie`))
    }
    finally {
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it('sends the browser where a called action redirects', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/admin' })

    try {
      void readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/about' } }))
      // The swap is imported first, which takes a tick.
      await Bun.sleep(10)
      expect(window.location.href).toBe('http://localhost/about')
      await expect(readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': 'javascript:alert(1)' } }))).rejects.toThrow('which is no page')
      expect(window.location.href).toBe('http://localhost/about')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
