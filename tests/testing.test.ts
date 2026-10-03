import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { ActionError } from '../src/runtime'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/site/src/routes'
const site = await testSite({ routes, publicDir: 'tests/fixtures/site/public', locals: request => ({ user: request.headers.get('x-user') ?? undefined }) })
// Imported once the site is up, which registers the `.kay` loader this process needs.
const { add } = await import(join(import.meta.dir, 'fixtures/site/src/routes/index.kay')) as { add: Action<{ title: string }, number> }

describe('kay/test', () => {
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
    expect(await site.call(add, { title: 'Called from a test' })).toBeNumber()
    await expect(site.call(add, { title: '' })).rejects.toThrow(ActionError)
  })
})
