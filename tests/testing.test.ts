import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { ActionError } from '../src/runtime'
import { readActionResponse } from '../src/runtime/action'
import { testSite } from '../src/test'
import { resetTodos } from './fixtures/site/src/data'

const routes = 'tests/fixtures/site/src/routes'
// A 1x1 PNG, which Elysia's `t.File({ type: 'image/png' })` recognises from its bytes.
const PNG = Uint8Array.fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')
const site = await testSite({ routes, publicDir: 'tests/fixtures/site/public', locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
// Imported once the site is up, which registers the `.kay` loader this process needs.
const { add } = await import(join(import.meta.dir, 'fixtures/site/src/routes/index.kay')) as { add: Action<{ title: string }, number> }

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

  it('submits a form without JavaScript and lands back on the page with its failure', async () => {
    const failed = await site.submit(add, { title: '' }, { from: '/' })

    expect(failed.url).toBe('/')
    expect(failed.html).toContain('<p class="error">Write a title</p>')
    expect(site.cookies.has('kay_failed')).toBe(false)
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

  it('sends the browser where a called action redirects', async () => {
    GlobalRegistrator.register({ url: 'http://localhost/admin' })

    try {
      void readActionResponse(new Response(null, { status: 303, headers: { 'x-kay-redirect': '/about' } }))
      expect(window.location.href).toBe('http://localhost/about')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
