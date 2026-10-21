import type { Action, Failure, NoInputAction, s, ServerAction } from '../src/runtime'
import type { TestSite } from '../src/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { ActionError } from '../src/runtime'
import { ActionRedirectError, readActionResponse } from '../src/runtime/action'
import { leaveGuards } from '../src/runtime/navigation'
import { session } from '../src/server/session'
import { testSite } from '../src/test'
import { NativeRequest, withNatives } from '../src/test/natives'
import { readPage } from '../src/test/page'
import { resetTodos } from './fixtures/site/src/data'

async function until(condition: () => boolean, timeout = 5000): Promise<void> {
  for (const start = Date.now(); !condition(); await Bun.sleep(5)) {
    if (Date.now() - start > timeout)
      throw new Error('timed out')
  }
}

const routes = 'tests/fixtures/site/src/routes'

// The schema of the admin page's actions, which take a name.
type Named = ReturnType<typeof s.Object<{ name: ReturnType<typeof s.String> }>>
// A 1x1 PNG, which Elysia's `t.File({ type: 'image/png' })` recognises from its bytes.
const PNG = Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
const site = await testSite({ routes, publicDir: 'tests/fixtures/site/public', locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
// Made at the top of the file as `site` is, so each test posts to it as a client of its own.
const sessions = await testSite({ routes: 'tests/fixtures/session/src/routes', use: [session({ secret: 'a test secret of at least 32 characters' })] })
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

  it('calls an action declared without a schema with no input at all', async () => {
    const bare = await testSite({ routes: 'tests/fixtures/bare/src/routes' })
    const { ping } = await import(join(import.meta.dir, 'fixtures/bare/src/routes/survey.kay')) as { ping: NoInputAction<string> }

    // Any action passes where a form or a helper takes one of any input.
    const asAnyAction: Action<never, unknown> = ping

    expect(asAnyAction).toBe(ping)
    expect(await bare.call(ping)).toBe('pong')
    expect(await bare.call(ping, {})).toBe('pong')
    expect(await bare.call(ping, new FormData())).toBe('pong')
    // `with` fixes fields the schema names, and only those.
    expect(add.with({ title: 'Fixed' })).toBeFunction()
    // @ts-expect-error -- no such field
    expect(add.with({ nope: 1 })).toBeFunction()
    // `bun run check` fails on an `@ts-expect-error` with no error under it, so the type check is what this asserts.
    // @ts-expect-error -- an action with fields needs them
    const missing = async () => bare.call(add)

    expect(missing).toBeFunction()
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
    await expect(signed.call(signOut, form([]))).rejects.toMatchObject({ name: 'ActionRedirectError', location: '/' })
    expect(await signed.call(limited, form([]))).toBe('ok')
    await expect(signed.call(limited, form([]))).rejects.toMatchObject({ status: 429 })
    // The honeypot catches a form's fields however they are sent.
    await expect(signed.call(profile, form([['age', '1'], ['website', 'spam']]))).rejects.toMatchObject({ status: 422, errors: { website: 'Leave this field empty' } })
  })

  it('serves a project setting no site at its own origin, as pages reading it render', async () => {
    const unset = await testSite({ routes: 'tests/fixtures/production/src/routes', security: false })

    expect((await unset.visit('/origin')).html).toContain('<p class="origin">http://localhost</p>')
  })

  it('goes on working once a test registered a DOM, as one of `mountComponent` leaves it for every later file', async () => {
    GlobalRegistrator.register()

    try {
      const echo = await testSite({ routes: 'tests/fixtures/bare/src/routes', use: [new Elysia().get('/echo', ({ headers }) => headers['x-user'] ?? 'nobody')] })

      expect(await (await echo.fetch('/echo', { headers: { 'x-user': 'ada' } })).text()).toBe('ada')
      expect((await site.submit(add, { title: 'Sent under a DOM' })).html).toContain('Sent under a DOM</a></li>')
      // A refused post renders its page, and one that succeeded shows what it returned there, through the app.
      expect((await site.submit(add, { title: '' }, { from: '/' })).text('p.error')).toBe('Write a title')
      expect((await site.submit(schedule, { title: 'Launch', at: '2026-10-04T10:00:00Z' }, { from: '/events' })).text('p.done')).toStartWith('Scheduled Launch')
      expect(await site.call(add, { title: 'Called under a DOM' })).toBeNumber()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('leaves a function the test stubbed, such as fetch, to the app, while its classes are Bun\'s', async () => {
    GlobalRegistrator.register()
    const stub = spyOn(globalThis, 'fetch')

    try {
      const seen = await withNatives(async () => [(globalThis.fetch as unknown) === stub, globalThis.Request === NativeRequest])

      expect(seen).toEqual([true, true])
      expect(globalThis.Request).not.toBe(NativeRequest)
    }
    finally {
      stub.mockRestore()
      await GlobalRegistrator.unregister()
    }
  })

  it('says how to test a second project, which a process already serving one cannot', async () => {
    await expect(testSite({ root: 'tests/fixtures/islands' })).rejects.toThrow('`bun test --parallel` runs each file apart, or run its tests on their own as `KAY_ROOT=tests/fixtures/islands bun test <its test files>`')
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
    // Spaces are no title, and those around one are dropped.
    expect((await site.submit(add, { title: '   ' })).html).toContain('<p class="error">Write a title</p>')
    expect((await site.submit(add, { title: '  Trimmed  ' })).html).toContain('>Trimmed</a></li>')
  })

  it('shows the message an action gives for a handler that throws under its form, keeping what was typed, and logs the error', async () => {
    const { send, explode } = await import(join(import.meta.dir, 'fixtures/site/src/routes/boom.kay')) as { send: Action<{ message: string }, never>, explode: Action<Record<string, never>, never> }
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const failed = await site.submit(send, { message: 'Hello there' }, { from: '/boom' })

      expect(failed).toMatchObject({ url: '/boom', status: 500 })
      expect(failed.html).toContain('<p id="send-error" class="error">Not sent; write to hello@example.com instead</p>')
      expect(failed.find('textarea[name="message"]')[0]!.text).toBe('Hello there')
      expect((await site.submit(explode, {}, { from: '/boom' })).html).toContain('<p id="explode-error" class="error">Something went wrong on our side; try again later</p>')
      await expect(site.call(send, { message: 'Hello' })).rejects.toMatchObject({ status: 500, errors: { '': 'Not sent; write to hello@example.com instead' } })
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('Error: Mail server down'))
    }
    finally {
      logged.mockRestore()
    }
  })

  it('submits again from the page a refused post answered, refused or not', async () => {
    const failed = await site.submit(add, { title: '' }, { from: '/' })
    const again = await site.submit(add, { title: '' }, { from: failed })

    expect(again).toMatchObject({ url: '/', status: 422 })
    expect(again.html).toContain('<p class="error">Write a title</p>')

    const through = await site.submit(add, { title: 'Refused twice first' }, { from: await site.submit(add, { title: '' }, { from: again }) })

    expect(through).toMatchObject({ url: '/', status: 200 })
    expect(through.html).toContain('Refused twice first</a></li>')
  })

  it('calls an action as an island does', async () => {
    const { promote, demote } = await import(join(import.meta.dir, 'fixtures/site/src/routes/admin/index.kay')) as {
      promote: Action<{ name: string }, string>
      demote: ServerAction<Named, Failure<{ error: string }> | undefined>
    }

    expect(await site.call(add, { title: 'Called from a test' })).toBeNumber()
    await expect(site.call(add, { title: '' })).rejects.toThrow(ActionError)
    expect(await site.call(promote, { name: 'bob' }, { headers: { 'x-user': 'ada' } })).toBe('bob is an admin')
    await expect(site.call(promote, { name: 'bob' })).rejects.toMatchObject({ name: 'ActionRedirectError', status: 303, location: '/about' })
    expect(await site.call(demote, { name: 'bob' }, { headers: { 'x-user': 'ada' } })).toBeUndefined()
    await expect(site.call(demote, { name: 'ada' }, { headers: { 'x-user': 'ada' } })).rejects.toMatchObject({ status: 422, data: { error: 'ada stays an admin' } })
  })

  it('tells a refused call of an action apart, its data typed from the handler', async () => {
    const { promote, demote } = await import(join(import.meta.dir, 'fixtures/site/src/routes/admin/index.kay')) as {
      promote: Action<{ name: string }, string>
      demote: ServerAction<Named, Failure<{ error: string }> | undefined>
    }
    let reason: string | undefined

    try {
      await site.call(demote, { name: 'ada' }, { headers: { 'x-user': 'ada' } })
    }
    catch (error) {
      expect(promote.refused(error)).toBe(false)

      if (demote.refused(error))
        reason = error.data?.error
    }

    try {
      await site.call(promote, { name: 'bob' })
    }
    catch (error) {
      expect(error).toMatchObject({ name: 'ActionRedirectError' })
      expect(promote.refused(error)).toBe(false)
    }

    expect(reason).toBe('ada stays an admin')
    expect(demote.refused(new ActionError(422, '', {}, { error: 'forged' }))).toBe(false)
  })

  it('reads back a call expected to be refused, and fails one that went through', async () => {
    const { promote, demote } = await import(join(import.meta.dir, 'fixtures/site/src/routes/admin/index.kay')) as {
      promote: Action<{ name: string }, string>
      demote: ServerAction<Named, Failure<{ error: string }> | undefined>
    }
    const refused = await site.refusal(demote, { name: 'ada' }, { headers: { 'x-user': 'ada' } })
    const reason: string | undefined = refused.data?.error

    expect(refused).toMatchObject({ status: 422, errors: {} })
    expect(reason).toBe('ada stays an admin')
    expect(await site.refusal(add, { title: '' })).toMatchObject({ status: 422, errors: { title: 'Write a title' }, data: undefined })
    // @ts-expect-error: the handler fails with `error` alone.
    expect(refused.data?.message).toBeUndefined()
    await expect(site.refusal(demote, { name: 'bob' }, { headers: { 'x-user': 'ada' } })).rejects.toThrow('went through, where a refusal was expected')
    await expect(site.refusal(promote, { name: 'bob' })).rejects.toMatchObject({ name: 'ActionRedirectError', location: '/about' })
  })

  it('calls an action reading its params from the page it names', async () => {
    const { which } = await import(join(import.meta.dir, 'fixtures/site/src/routes/todos/[id].kay')) as { which: Action<Record<string, never>, Record<string, unknown>> }

    expect(await site.call(which, {}, { from: '/todos/7' })).toEqual({ id: '7' })
    await expect(site.call(which, {})).rejects.toMatchObject({ name: 'ActionError', status: 400 })
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
    expect((await site.submit(schedule, { title: 'Old', at: '1990-01-01T00:00:00Z' }, { from: '/events' })).text('p.error')).toBe('Not before 2000')
  })

  it('shows the page what a plain form post that succeeded returned, once', async () => {
    const page = await site.submit(schedule, { title: 'Launch', at: '2026-10-04T10:00:00Z' }, { from: '/events' })

    expect(page.url).toBe('/events')
    // Read as a visitor reads it, as one string, where an island's markup holds hydration markers between its parts.
    expect(page.html).not.toContain('2000 1')
    expect(page.text('button.since')).toBe('2000 1')
    expect(page.text('p.done')).toBe('Scheduled Launch on 2026-10-04T10:00:00.000Z, 1 tag, 10 seats')
    expect(page.text()).toContain('Scheduled Launch on 2026-10-04T10:00:00.000Z, 1 tag, 10 seats')
    expect(page.text('p.missing')).toBeUndefined()
    expect((await site.visit('/events')).html).not.toContain('class="done"')
  })

  it('answers a call whose result cannot reach the browser with a 500 naming what holds it, and still lands a plain form on its page', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined)
    const warned = spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await expect(site.call(leak, {})).rejects.toMatchObject({ status: 500 })
      expect(logged).toHaveBeenCalledWith(expect.stringContaining(`kay: what ${leak.url} returned cannot reach the browser: Cannot stringify arbitrary non-POJOs at .format`))
      expect(await site.submit(leak, {}, { from: '/events' })).toMatchObject({ url: '/events', status: 200 })
      expect(warned).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^kay: POST ${leak.url}, request \\S+: what ${leak.url} returned cannot reach the page through its cookie`)))
    }
    finally {
      logged.mockRestore()
      warned.mockRestore()
    }
  })

  it('renders the page a refused post came from, however much it posted', async () => {
    const page = await site.submit(schedule, { title: 'é'.repeat(4000), at: '1990-01-01T00:00:00Z' }, { from: '/events' })

    expect(page.url).toBe('/events')
    expect(page.text('p.error')).toBe('Not before 2000')
    expect(site.cookies.has('kay_flash')).toBe(false)
  })

  it('sends the browser where a called action redirects once the leave guards let it go, and settles the call when they keep it', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/admin' })

    const asked: string[] = []
    let leaving = false
    const guard = {
      dirty: () => true,
      confirm: (to: URL) => {
        asked.push(to.pathname)

        return leaving
      },
    }

    leaveGuards.add(guard)

    try {
      // Kept on the page, the call settles, so its `pending` clears.
      await expect(readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/about' } }), '/_kay/action/test/go')).rejects.toBeInstanceOf(ActionRedirectError)
      expect([asked, window.location.href]).toEqual([['/about'], 'http://localhost/admin'])
      // Made on a page the visitor has left since, it takes them nowhere.
      await expect(readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/about' } }), '/_kay/action/test/go', () => true)).rejects.toBeInstanceOf(ActionRedirectError)
      expect(asked).toEqual(['/about'])

      leaving = true
      void readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/about' } }), '/_kay/action/test/go')
      // The swap is imported first.
      await until(() => window.location.href === 'http://localhost/about')
      await expect(readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': 'javascript:alert(1)' } }), '/_kay/action/test/go')).rejects.toThrow('which is no page')
      expect(window.location.href).toBe('http://localhost/about')
    }
    finally {
      leaveGuards.delete(guard)
      await GlobalRegistrator.unregister()
    }
  })
})

describe('testSite under a base', () => {
  it('throws the redirect of a called action with the base on its location', async () => {
    const mounted = await testSite({ routes, base: '/app' })

    try {
      const { promote } = await import(join(import.meta.dir, 'fixtures/site/src/routes/admin/index.kay')) as { promote: Action<{ name: string }, string> }

      await expect(mounted.call(promote, { name: 'bob' })).rejects.toMatchObject({ name: 'ActionRedirectError', status: 303, location: '/app/about' })
    }
    finally {
      await mounted.close()
    }
  })
})

describe('testSite in development', () => {
  it('serves its pages as kay dev does with dev: true, and as production otherwise', async () => {
    const dev = await testSite({ routes, dev: true })

    try {
      expect((await dev.fetch('/_kay/dev/patch.js')).status).toBe(200)
      expect((await site.fetch('/_kay/dev/patch.js')).status).toBe(404)
    }
    finally {
      await dev.close()
    }
  })
})

describe('reading a page', () => {
  afterAll(resetTodos)

  const seo = { name: 'Kay & co', titleTemplate: '%s | Kay & co', description: 'A site built with kay', jsonLd: [{ '@type': 'WebSite', 'name': 'Kay </script>  site' }, { '@type': 'Organization', 'name': 'Kay & co' }] }
  // Built once the tests before have built theirs, as the last site sets the origin siteUrl() reads.
  let read: TestSite

  beforeAll(async () => {
    read = await testSite({ routes: 'tests/fixtures/seo/src/routes', publicDir: 'tests/fixtures/seo/public', site: 'https://example.com/', seo })
  })

  it('gives its title, meta, canonical URL and JSON-LD as a crawler reads them', async () => {
    const page = await read.visit('/about')

    expect(page.title()).toBe('About | Kay & co')
    expect(page.meta('description')).toBe('Who we are')
    expect(page.meta('og:site_name')).toBe('Kay & co')
    expect(page.meta('og:image')).toBeUndefined()
    expect(page.canonical()).toBe('https://example.com/about')
    // A @graph's items one by one, a script's text read as written.
    expect(page.jsonLd()).toEqual([{ '@context': 'https://schema.org', '@type': 'WebSite', 'name': 'Kay </script>  site' }, { '@context': 'https://schema.org', '@type': 'Organization', 'name': 'Kay & co' }])
  })

  it('gives its links and the elements a selector matches, their text squashed', async () => {
    const page = await read.visit('/trail')

    expect(page.links()).toEqual(['/', '/trail/', '/trail?tab=2', '/trail#end', '/trail'])
    expect(page.find('a[aria-current="page"]')).toEqual([{ tag: 'a', attributes: { 'href': '/trail/', 'aria-current': 'page' }, text: 'Trail', html: 'Trail' }])
    expect(page.find('nav')[0]!.text).toBe('HomeTrailTabEndStep')
    expect(page.jsonLd()).toContainEqual(expect.objectContaining({ '@type': 'BreadcrumbList' }))
    expect(page.find('h2')).toEqual([])
  })

  it('gives the markup an element holds as the page wrote it, empty for one that holds none', () => {
    const page = readPage('<body><a href="/" class="logo"><svg viewBox="0 0 1 1"><path d="M0"/></svg> Home &amp; <b>away</b></a><a href="/x"><img src="a.png"></a><br><ul><li><ul><li>deep</li></ul></li></ul></body>')
    const [logo, plain] = page.find('a')

    expect(logo!.html).toBe('<svg viewBox="0 0 1 1"><path d="M0"/></svg> Home &amp; <b>away</b>')
    expect(logo!.text).toBe('Home & away')
    expect(plain!.html).toBe('<img src="a.png">')
    expect(page.find('img')[0]!.html).toBe('')
    expect(page.find('br')[0]!.html).toBe('')
    // A selector matching nested elements gives each its own.
    expect(page.find('ul').map(({ html }) => html)).toEqual(['<li><ul><li>deep</li></ul></li>', '<li>deep</li>'])
    expect(page.find('li').map(({ html }) => html)).toEqual(['<ul><li>deep</li></ul>', 'deep'])
    // An element the page never closes holds the rest of it, as the parser sees no end tag to stop at.
    expect(readPage('<span>one<b>x</b>').find('span')[0]!.html).toBe('one<b>x</b>')
  })

  it('ends an element a browser closes by itself where the browser would', () => {
    expect(readPage('<p>one<p>two').find('p').map(({ html, text }) => [html, text])).toEqual([['one', 'one'], ['two', 'two']])
    expect(readPage('<p>one<div>x</div>').find('p')[0]!.html).toBe('one')
    expect(readPage('<ul><li>a<li>b<ul><li>c</ul><li>d</ul>tail').find('li').map(({ html }) => html)).toEqual(['a', 'b<ul><li>c</ul>', 'c', 'd'])
    expect(readPage('<dl><dt>a<dd>b<dt>c</dl>').find('dd, dt').map(({ html }) => html)).toEqual(['a', 'b', 'c'])
  })

  it('closes an element through the open elements above it, without crossing a scope boundary', () => {
    const htmls = (html: string, selector: string) => readPage(html).find(selector).map(({ html }) => html)

    expect(htmls('<ul><li><span>a<li>b</ul>', 'li')).toEqual(['<span>a', 'b'])
    expect(htmls('<ul><li><div>a<li>b</div></ul>', 'li')).toEqual(['<div>a', 'b'])
    expect(htmls('<ul><li>a<ul><li>b</ul><li>c</ul>', 'li')).toEqual(['a<ul><li>b</ul>', 'b', 'c'])
    expect(htmls('<dl><dt><b>a<dd>b</dl>', 'dt, dd')).toEqual(['<b>a', 'b'])
    expect(htmls('<div><p><b>one<div>two</div>', 'p')).toEqual(['<b>one'])
    expect(htmls('<p><span>one<p>two', 'p')).toEqual(['<span>one', 'two'])
    // A table cell or a button holds its own scope: the outer paragraph stays open.
    expect(htmls('<p>a<button>b<div>c</div></button>d', 'p')).toEqual(['a<button>b<div>c</div></button>d'])
    expect(htmls('<p>a<table><tr><td>b<div>c</div></td></tr></table>d', 'p')).toEqual(['a'])
  })

  it('closes cells, rows, sections and options by the next one', () => {
    const htmls = (html: string, selector: string) => readPage(html).find(selector).map(({ html }) => html)

    expect(htmls('<table><tr><td>a<td>b<th>c</table>', 'td, th')).toEqual(['a', 'b', 'c'])
    expect(htmls('<table><tr><td><b>a<td>b</table>', 'td')).toEqual(['<b>a', 'b'])
    expect(htmls('<table><tr><td>a<tr><td>b</table>', 'tr')).toEqual(['<td>a', '<td>b'])
    expect(htmls('<table><thead><tr><th>a<tbody><tr><td>b</table>', 'thead, tbody')).toEqual(['<tr><th>a', '<tr><td>b'])
    expect(htmls('<table><tbody><tr><td>a<tbody><tr><td>b</table>', 'tbody')).toEqual(['<tr><td>a', '<tr><td>b'])
    // A table nested in a cell has its own rows.
    expect(htmls('<table><tr><td><table><tr><td>x</table><td>y</table>', 'td')).toEqual(['<table><tr><td>x</table>', 'x', 'y'])
    expect(htmls('<select><option>a<option>b<optgroup label=g><option>c</select>', 'option, optgroup')).toEqual(['a', 'b', '<option>c', 'c'])
    expect(htmls('<select><optgroup label=a><option>x<optgroup label=b><option>y</select>', 'optgroup')).toEqual(['<option>x', '<option>y'])
  })

  it('reads the markup of an element beside a comment that looks like its own marker', () => {
    const page = readPage('<!--kay-open-0--><p>one</p><!--kay-close-0-->')

    expect(page.find('p')[0]!.html).toBe('one')
  })

  it('decodes entities and squashes whitespace in the text it gives', async () => {
    const page = await site.submit(add, { title: 'Paint  <walls> &\n  doors' }, { from: '/' })

    expect(page.find('li a').at(-1)!.text).toBe('Paint <walls> & doors')
    // The page's text leaves out its scripts, which a visitor never reads.
    expect(page.html).toContain('<script')
    expect(page.text()).toContain('Paint <walls> & doors')
    expect(page.text()).not.toContain('{')
  })

  it('reads past a self-closing script or style, as an inline SVG may hold', () => {
    expect(readPage('<body><svg><style/><script/></svg><p>Shown</p></body>').text()).toBe('Shown')
  })

  it('lists the sitemap\'s URLs, and fails on one that does not answer', async () => {
    expect(await read.sitemap()).toContain('https://example.com/about')
    expect(await read.sitemap()).toContain('https://example.com/blog/a%20%26%20b')
    await expect(read.sitemap('/nope.xml')).rejects.toThrow('/nope.xml answered 404')
  })
})

describe('the test preload', () => {
  it('drops what only the developer\'s .env sets, keeping the shell\'s and .env.test\'s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-env-'))

    try {
      await Bun.write(join(dir, '.env'), 'SMTP_USER=me@example.com\nKAY_SHELL=from .env\nKAY_BOTH=dev\n')
      await Bun.write(join(dir, '.env.test'), 'KAY_BOTH=test\n')
      await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = ["${join(import.meta.dir, '../src/test/preload.ts')}"]\n`)
      const test = 'import { expect, it } from \'bun:test\'\nit(\'env\', () => expect([process.env.SMTP_USER, process.env.KAY_SHELL, process.env.KAY_BOTH]).toEqual([undefined, \'shell\', \'test\']))\n'

      // Two files, so --parallel runs them in workers.
      await Bun.write(join(dir, 'env.test.ts'), test)
      await Bun.write(join(dir, 'env-again.test.ts'), test)

      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_ENV'))

      // A --parallel worker starts with its coordinator's variables, `.env`'s included.
      for (const args of [['test'], ['test', '--parallel=2']]) {
        const child = Bun.spawn([process.execPath, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...env, KAY_SHELL: 'shell' } })
        const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()])

        expect(output).toContain('2 pass')
        expect(code).toBe(0)
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a client per test', () => {
  const limit = async () => (await import(join(import.meta.dir, 'fixtures/session/src/routes/index.kay')) as { limited: Action<Record<string, never>, string> }).limited

  it('counts a rate limit over the posts one test sends', async () => {
    const limited = await limit()

    expect(await sessions.call(limited, {})).toBe('ok')
    await expect(sessions.call(limited, {})).rejects.toMatchObject({ status: 429 })
  })

  it('posts as another client in the next test, whatever the one before sent', async () => {
    expect(await sessions.call(await limit(), {})).toBe('ok')
  })

  it('posts as the client the header of a trusted proxy names', async () => {
    const limited = await limit()
    const proxied = await testSite({ routes: 'tests/fixtures/session/src/routes', use: [session({ secret: 'a test secret of at least 32 characters' })], proxy: { header: 'x-real-ip' } })
    const from = (address: string) => ({ headers: { 'x-real-ip': address } })

    expect(await proxied.call(limited, {}, from('203.0.113.9'))).toBe('ok')
    await expect(proxied.call(limited, {}, from('203.0.113.9'))).rejects.toMatchObject({ status: 429 })
    expect(await proxied.call(limited, {}, from('203.0.113.10'))).toBe('ok')
  })
})
