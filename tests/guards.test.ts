import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { writeShadowTypes } from '../src/check'
import { pages } from '../src/server'
import { falseKeys } from '../src/server/routes'
import { scratchDir } from './scratch'

const ACTION = (name: string, settings: string, body: string) => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\n${settings}export const ${name} = action(t.Object({}), () => '${name}')\n---\n${body}\n`
const ADMINS = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-admin\'))\n    deny(403, \'Admins only\')\n})\n'
const OPEN = 'export const page = { guards: false }\n'

describe('requireGuards', () => {
  let dir = ''
  let required: Awaited<ReturnType<typeof pages>>
  let optional: Awaited<ReturnType<typeof pages>>

  const status = async (app: typeof required, path: string, headers: Record<string, string> = {}) => (await app.handle(new Request(`http://localhost${path}`, { headers }))).status
  const post = async (file: string, name: string, headers: Record<string, string> = {}) => {
    const response = await required.handle(new Request(`http://localhost/_kay/action/${relative(process.cwd(), join(dir, 'routes'))}/${file}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/', ...headers },
      body: stringify({}),
    }))

    return response.status
  }

  beforeAll(async () => {
    dir = await scratchDir('required-guards-')
    await Promise.all([
      Bun.write(join(dir, 'routes/_layout.kay'), ACTION('leave', '', 'slot')),
      Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'routes/login.kay'), ACTION('signIn', OPEN, 'h1 Login')),
      Bun.write(join(dir, 'routes/admin/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'routes/admin/index.kay'), ACTION('rename', '', 'h1 Admin')),
      Bun.write(join(dir, 'routes/admin/sign-in.kay'), `--- server\n${OPEN}---\nh1 Sign in\n`),
      Bun.write(join(dir, 'routes/feed.json.ts'), 'export function GET() {\n  return \'items\'\n}\n'),
      Bun.write(join(dir, 'routes/status.json.ts'), `${OPEN}\nexport function GET() {\n  return 'up'\n}\n`),
      Bun.write(join(dir, 'api/notes.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => [])\n'),
      Bun.write(join(dir, 'api/health.ts'), 'import { api } from \'kay/server\'\n\nexport default api({ guards: false }).get(\'/\', () => \'up\')\n'),
      Bun.write(join(dir, 'api/admin/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'api/admin/index.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'secret\')\n'),
    ])
    required = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: false, requireGuards: true })
    optional = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: false })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('refuses a page, an endpoint and an API module no guard covers, and serves those that set guards: false', async () => {
    expect(await status(required, '/')).toBe(403)
    expect(await status(required, '/login')).toBe(200)
    expect(await status(required, '/feed.json')).toBe(403)
    expect(await status(required, '/status.json')).toBe(200)
    expect(await status(required, '/api/notes')).toBe(403)
    expect(await status(required, '/api/health')).toBe(200)
  })

  it('serves what a guard lets through, as without it', async () => {
    expect(await status(required, '/admin')).toBe(403)
    expect(await status(required, '/admin', { 'x-admin': '1' })).toBe(200)
    expect(await status(required, '/api/admin', { 'x-admin': '1' })).toBe(200)
  })

  it('runs none of the guards above a page that sets guards: false', async () => {
    expect(await status(required, '/admin/sign-in')).toBe(200)
    expect(await status(optional, '/admin/sign-in')).toBe(200)
  })

  it('refuses an action no guard covers, a layout\'s by the guards of its own directory', async () => {
    expect(await post('login.kay', 'signIn')).toBe(200)
    expect(await post('admin/index.kay', 'rename')).toBe(403)
    expect(await post('admin/index.kay', 'rename', { 'x-admin': '1' })).toBe(200)
    expect(await post('_layout.kay', 'leave')).toBe(403)
  })

  it('is reported by kay check, route by route, layouts with actions included', async () => {
    const reported = async (requireGuards: boolean) => (await writeShadowTypes(dir, { routes: 'routes', api: 'api', requireGuards })).problems.filter(found => found.code === 'unguarded-route').map(found => [relative(dir, found.file), found.message])

    expect(await reported(true)).toEqual([
      ['routes/index.kay', 'No guard covers `/`, so the server refuses it'],
      ['routes/_layout.kay', 'No guard covers the actions of this layout, `leave`, so the server refuses them'],
      ['routes/feed.json.ts', 'No guard covers `/feed.json`, so the server refuses it'],
      ['api/notes.ts', 'No guard covers `/api/notes`, so the server refuses its routes'],
    ])
    expect(await reported(false)).toEqual([])
  })

  it('leaves a site without it as it was', async () => {
    expect(await status(optional, '/')).toBe(200)
    expect(await status(optional, '/feed.json')).toBe(200)
    expect(await status(optional, '/api/notes')).toBe(200)
  })
})

describe('falseKeys', () => {
  it('reads the keys of the page object set to false, quoted or not, and none nested in a value or a comment', () => {
    expect(falseKeys('export const page = {\n  \'layouts\': false, guards: false,\n  sitemap: { guards: false },\n  // noindex: false\n}\n')).toEqual(new Set(['layouts', 'guards']))
    expect(falseKeys('export const page = { guards: falsey }\n')).toEqual(new Set())
    expect(falseKeys('const other = { guards: false }\n')).toEqual(new Set())
    expect(falseKeys('export default api({ cors: { origins: [] }, guards: false })\n', /\bapi\s*\(\s*\{/)).toEqual(new Set(['guards']))
  })
})
