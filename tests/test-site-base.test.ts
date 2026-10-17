import type { Action } from '../src/runtime'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/base-site/src/routes'
const api = 'tests/fixtures/base-site/src/api'
const site = await testSite({ routes, api, base: '/blog', islands: false })
const strict = await testSite({ routes, api, base: '/blog', trailingSlash: 'always', islands: false })
const { enter } = await import(join(import.meta.dir, 'fixtures/base-site/src/routes/index.kay')) as { enter: Action<{ name: string }, unknown> }

afterAll(async () => {
  await Promise.all([site.close(), strict.close()])
})

describe('testSite under base', () => {
  it('visits a path given with the base, without it, and the base itself with and without a slash', async () => {
    for (const path of ['/home', '/blog/home', '/', '/blog', '/blog/']) {
      const page = await site.visit(path)

      expect(page.status).toBe(200)
      expect(page.find('h1')[0]?.text).toBe(path === '/home' || path === '/blog/home' ? 'Home' : 'Start')
    }
  })

  it('shows urls as the browser does, under the base', async () => {
    const page = await site.visit('/home?x=1')

    expect(page.url).toBe('/blog/home?x=1')
    expect(page.find('a')[0]?.attributes.href).toBe('/blog/home')
  })

  it('serves a route that starts like the base only when it is given the base too', async () => {
    expect((await site.visit('/blog/blog/home')).status).toBe(404)
  })

  it('follows a redirect to a base-prefixed url with the cookies', async () => {
    const jar = await testSite({ routes, api, base: '/blog', islands: false })
    const response = await jar.fetch('/api/cookies/enter')

    expect(response.headers.get('location')).toBe('/blog/home')

    const page = await jar.visit('/api/cookies/enter')

    expect(page).toMatchObject({ url: '/blog/home', status: 200 })
    expect(await (await jar.fetch('/blog/api/cookies/read')).text()).toBe('scoped=a; wide=b')
    await jar.close()
  })

  it('scopes a cookie to its Path, the base or the whole host', async () => {
    const jar = await testSite({ routes, api, base: '/blog', islands: false })

    await jar.fetch('/api/cookies/enter')
    await jar.fetch('/api/cookies/elsewhere')

    expect(jar.cookies.get('other')).toBe('c')
    expect(await (await jar.fetch('/api/cookies/read')).text()).toBe('scoped=a; wide=b')
    await jar.close()
  })

  it('submits a form that redirects, with the form posting to a base-prefixed action', async () => {
    const start = await site.visit('/')

    expect(start.find('form')[0]?.attributes.action).toBe(`/blog${enter.url}`)

    const done = await site.submit(enter, { name: 'Ada' }, { from: start })

    expect(done).toMatchObject({ url: '/blog/home', status: 200 })
    expect((await site.submit(enter, { name: 'Ada' }, { from: '/blog/' })).url).toBe('/blog/home')
    expect((await site.submit(enter, { name: 'Ada' })).url).toBe('/blog/home')
  })

  it('calls an action', async () => {
    await expect(site.call(enter, { name: 'Ada' })).rejects.toMatchObject({ location: '/blog/home' })
  })

  it('serves the mcp endpoint under the base', async () => {
    const mcp = await testSite({ routes, api, base: '/blog', mcp: true, islands: false })

    expect((await mcp.mcp.tools()).map(tool => tool.name)).toEqual(['get_cookies_read'])
    await mcp.close()
  })

  it('works with trailingSlash on', async () => {
    for (const path of ['/home', '/blog/home', '/home/', '/blog/home/']) {
      const page = await strict.visit(path)

      expect(page).toMatchObject({ url: '/blog/home/', status: 200 })
    }

    expect((await strict.visit('/blog')).find('h1')[0]?.text).toBe('Start')
  })
})

describe('testSite at the root', () => {
  it('leaves paths as they are', async () => {
    const root = await testSite({ routes, api, islands: false })

    expect((await root.visit('/home')).url).toBe('/home')
    expect((await root.visit('/blog/home')).status).toBe(404)
    await root.close()
  })
})
