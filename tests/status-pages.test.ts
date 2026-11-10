import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { unusedStatusPages } from '../src/check/status-pages'
import { scanRoutes } from '../src/server/routes'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const guard = (body: string) => `import { guard } from 'kay'\n\nexport default guard(${body})\n`
const special = (name: string) => `--- server\nconst { status, message } = ctx.error\nconst plan = (ctx.error.data as { plan: string } | undefined)?.plan ?? 'none'\n---\nh1.${name} ${name} {status} {message}\np.plan {plan}\n`
const gated = (call: string) => `--- server\nexport const page = { guards: false }\n${call}\n---\nh1 Never\n`

async function site(files: Record<string, string>) {
  const dir = await scratchDir('status-pages-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content)))

  const app = await pages({ dirs: { routes: dir }, prebuilt: false, security: false, requireGuards: false })

  return async (path: string) => {
    const response = await app.handle(new Request(`http://localhost${path}`))

    return { status: response.status, html: await response.text() }
  }
}

describe('status pages', () => {
  it('render for their status before _error.kay, which keeps every other one', async () => {
    const get = await site({
      '_error.kay': special('error'),
      '_403.kay': special('forbidden'),
      '_429.kay': special('limited'),
      '_503.kay': special('down'),
      '_401.kay': special('signin'),
      'a.kay': gated('ctx.deny(403, \'Members only\')'),
      'b.kay': gated('ctx.deny(429)'),
      'c.kay': gated('ctx.deny(503, \'Back soon\')'),
      'd.kay': gated('ctx.deny(401)'),
      'e.kay': gated('ctx.deny(418, \'Teapot\')'),
      'f.kay': gated('ctx.notFound()'),
    })

    expect(await get('/a')).toMatchObject({ status: 403, html: expect.stringContaining('<h1 class="forbidden">forbidden 403 Members only</h1>') })
    expect((await get('/b')).html).toContain('<h1 class="limited">limited 429 Too Many Requests</h1>')
    expect((await get('/c')).html).toContain('<h1 class="down">down 503 Back soon</h1>')
    expect((await get('/d')).html).toContain('<h1 class="signin">signin 401 Unauthorized</h1>')
    expect(await get('/e')).toMatchObject({ status: 418, html: expect.stringContaining('<h1 class="error">error 418 Teapot</h1>') })
    // A 404 is `_404.kay`'s, or the error page's when there is none, never a status page's.
    expect((await get('/f')).html).toContain('<h1 class="error">error 404 Not Found</h1>')
  })

  it('take the nearest directory first, a guard\'s denial included, and fall back to _error.kay when none exists', async () => {
    const get = await site({
      '_error.kay': special('error'),
      '_403.kay': special('root403'),
      'admin/_403.kay': special('admin403'),
      'admin/index.kay': 'h1 Admin\n',
      'admin/_guard.ts': guard('({ deny }) => deny(403, \'Admins only\')'),
      'admin/team/_error.kay': special('team'),
      'admin/team/index.kay': gated('ctx.deny(403)'),
      'shop/index.kay': gated('ctx.deny(403)'),
      'shop/limited.kay': gated('ctx.deny(429)'),
    })

    // A guard in `admin` is answered from the directory above it, so the root's page, not admin's own.
    expect((await get('/admin')).html).toContain('<h1 class="root403">root403 403 Admins only</h1>')
    // Below a nearer `_error.kay`, a status page further up still comes first, as `_404.kay` does.
    expect((await get('/admin/team')).html).toContain('<h1 class="admin403">admin403 403 Forbidden</h1>')
    expect((await get('/shop')).html).toContain('<h1 class="root403">root403 403 Forbidden</h1>')
    expect((await get('/shop/limited')).html).toContain('<h1 class="error">error 429 Too Many Requests</h1>')
  })

  it('hand ctx.deny\'s data to the page as ctx.error.data, and none without it', async () => {
    const get = await site({
      '_403.kay': special('forbidden'),
      '_error.kay': special('error'),
      'paid.kay': gated('ctx.deny(403, \'Upgrade\', { plan: \'pro\' })'),
      'free.kay': gated('ctx.deny(403)'),
      'other.kay': gated('ctx.deny(418, \'Teapot\', { plan: \'tea\' })'),
    })

    expect((await get('/paid')).html).toContain('<p class="plan">pro</p>')
    expect((await get('/free')).html).toContain('<p class="plan">none</p>')
    expect((await get('/other')).html).toContain('<p class="plan">tea</p>')
  })
})

describe('unused status pages', () => {
  it('are reported for a directory with no route under it, and nothing for one with a route', async () => {
    const root = await scratchDir('status-unused-')

    await Promise.all(Object.entries({
      'src/routes/index.kay': 'h1 Home\n',
      'src/routes/_403.kay': 'p root\n',
      'src/routes/admin/index.kay': 'h1 Admin\n',
      'src/routes/admin/_503.kay': 'p admin\n',
      'src/routes/empty/_429.kay': 'p nobody\n',
      'src/routes/empty/_error.kay': 'p not a status page\n',
    }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    const routes = await scanRoutes(join(root, 'src/routes'))
    const found = await unusedStatusPages(root, {}, { routes } as never)

    expect(found.map(({ file, message, severity }) => [file.slice(root.length + 1), message, severity])).toEqual([['src/routes/empty/_429.kay', '`empty/_429.kay` is in a directory with no route, so no page renders it', 'warning']])
  })
})
