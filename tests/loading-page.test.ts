import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { LOADING_HEADER } from '../src/runtime/swap'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const guard = (body: string) => `import { guard } from 'kay'\n\nexport default guard(${body})\n`
// A page whose fence records that it ran, which a loading request must never do.
const page = (name: string, extra = '') => `--- server\nconst seen = globalThis as { loaded?: string[] }\n\n;(seen.loaded ??= []).push('${name}')\n${extra}---\nh1.page ${name}\n`
const layout = (name: string) => `header.${name} ${name}\nmain\n  slot\n`

async function site(files: Record<string, string>, options: Record<string, unknown> = {}) {
  const dir = await scratchDir('loading-page-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content)))
  Reflect.deleteProperty(globalThis, 'loaded')

  const app = await pages({ dirs: { routes: dir }, prebuilt: false, security: false, requireGuards: false, ...options })

  return {
    // What a path answers when the swap asks for its loading page, or for the page itself.
    get: async (path: string, loading = true) => {
      const response = await app.handle(new Request(`http://localhost${path}`, { headers: loading ? { [LOADING_HEADER]: '1' } : {} }))

      return { status: response.status, headers: response.headers, html: await response.text() }
    },
    loaded: () => (globalThis as { loaded?: string[] }).loaded ?? [],
  }
}

const meta = (html: string) => (/<meta name="kay-loading" content="(\d+)">/).exec(html)?.[1]

describe('_loading.kay', () => {
  it('is rendered in place of the page, inside its layouts, and the page never runs', async () => {
    const { get, loaded } = await site({
      '_layout.kay': layout('root'),
      '_loading.kay': 'p.loading Loading\n',
      'slow.kay': page('slow'),
    })
    const answer = await get('/slow')

    expect(answer.status).toBe(200)
    expect(answer.html).toContain('<header class="root">root</header>')
    expect(answer.html).toContain('<p class="loading">Loading</p>')
    expect(answer.html).not.toContain('class="page"')
    expect(answer.headers.get(LOADING_HEADER)).toBe('1')
    expect(loaded()).toEqual([])
    // The page itself, asked without the header, is the page, and the loading page is none of it.
    const real = await get('/slow', false)

    expect(real.html).toContain('<h1 class="page">slow</h1>')
    expect(real.html).not.toContain('class="loading"')
    expect(real.headers.get(LOADING_HEADER)).toBeNull()
  })

  it('takes the nearest one up the tree, and the layouts of the page, not those of its own directory', async () => {
    const { get } = await site({
      '_layout.kay': layout('root'),
      '_loading.kay': 'p.root-loading Root\n',
      'admin/_layout.kay': layout('admin'),
      'admin/_loading.kay': 'p.admin-loading Admin\n',
      'admin/stats.kay': page('stats'),
      'shop/_layout.kay': layout('shop'),
      'shop/[id].kay': page('item'),
      '(group)/_layout.kay': layout('group'),
      '(group)/about.kay': page('about'),
    })

    const admin = (await get('/admin/stats')).html

    expect(admin).toContain('class="admin-loading"')
    expect(admin).toContain('<header class="admin">admin</header>')
    expect(admin).not.toContain('root-loading')

    // The root loading page inside the layouts of the shop page, not only the root's.
    const shop = (await get('/shop/5')).html

    expect(shop).toContain('class="root-loading"')
    expect(shop).toContain('<header class="shop">shop</header>')
    expect(shop).toContain('<header class="root">root</header>')

    expect((await get('/about')).html).toContain('<header class="group">group</header>')
  })

  it('reads the params of the page it stands in for', async () => {
    const { get } = await site({
      '_loading.kay': '--- server\nconst { id } = ctx.params\n---\np.loading Loading {id}\n',
      'shop/[id].kay': page('item'),
    })

    expect((await get('/shop/42')).html).toContain('<p class="loading">Loading 42</p>')
  })

  it('answers 204 for a page with no loading page above it, and a page not wrapped by layouts is shown without them', async () => {
    const { get } = await site({
      '_layout.kay': layout('root'),
      'docs/_loading.kay': 'p.docs-loading Docs\n',
      'docs/index.kay': page('docs'),
      'docs/bare.kay': '--- server\nexport const page = { layouts: false }\n---\nh1.page bare\n',
      'home.kay': page('home'),
    })
    const none = await get('/home')

    expect(none.status).toBe(204)
    expect(none.html).toBe('')
    expect(none.headers.get(LOADING_HEADER)).toBeNull()

    const bare = (await get('/docs/bare')).html

    expect(bare).toContain('class="docs-loading"')
    expect(bare).not.toContain('<header class="root">')
  })

  it('is kept by no cache, which could serve it for the page', async () => {
    const { get } = await site({ '_loading.kay': 'p.loading Loading\n', 'slow.kay': page('slow') })
    const { headers } = await get('/slow')

    expect(headers.get('cache-control')).toBe('private, no-store')
    expect(headers.get('etag')).toBeNull()
    expect(headers.get('vary')).toContain(LOADING_HEADER)
  })

  it('is not shown for a page a guard refuses, nor does the guard let it leak the page', async () => {
    const { get, loaded } = await site({
      '_loading.kay': 'p.loading Loading\n',
      '_error.kay': 'h1.error Error\n',
      'admin/_guard.ts': guard('({ deny }) => deny(403, \'Admins only\')'),
      'admin/index.kay': page('admin'),
      'login.kay': page('login'),
      'old.kay': '--- server\nctx.redirect(\'/login\')\n---\nh1 Old\n',
    })
    const denied = await get('/admin')

    expect(denied.status).toBe(403)
    expect(denied.html).not.toContain('class="loading"')
    expect(denied.headers.get(LOADING_HEADER)).toBeNull()
    expect(loaded()).toEqual([])
  })

  it('goes through the base and the trailing slash of the site', async () => {
    const { get } = await site({ '_loading.kay': 'p.loading Loading\n', 'slow.kay': page('slow') }, { base: '/app', trailingSlash: 'always' })
    // The mount point is the proxy's to strip: the server sees the path under it.
    const answer = await get('/slow/')

    expect(answer.status).toBe(200)
    expect(answer.html).toContain('<p class="loading">Loading</p>')
  })

  it('is told to the pages in a meta holding the delay, only on an app that has one', async () => {
    const withLoading = await site({ '_loading.kay': 'p.loading Loading\n', 'a.kay': page('a') })
    const without = await site({ 'a.kay': page('a') })
    const custom = await site({ '_loading.kay': 'p.loading Loading\n', 'a.kay': page('a') }, { client: { loadingDelay: '1s' } })

    expect(meta((await withLoading.get('/a', false)).html)).toBe('200')
    expect(meta((await without.get('/a', false)).html)).toBeUndefined()
    expect(meta((await custom.get('/a', false)).html)).toBe('1000')
  })
})
