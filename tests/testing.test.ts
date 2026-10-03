import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { ActionError } from '../src/runtime'
import { readActionResponse } from '../src/runtime/action'
import { testSite } from '../src/test'
import { resetTodos } from './fixtures/site/src/data'

const routes = 'tests/fixtures/site/src/routes'
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
