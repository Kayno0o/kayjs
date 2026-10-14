import { rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { writeShadowTypes } from '../src/check'
import { pages } from '../src/server'
import { exportedEndpoints } from '../src/server/endpoints'
import { falseKeys, scanEndpoints } from '../src/server/routes'
import { scratchDir } from './scratch'

const ACTION = (name: string, settings: string, body: string) => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\n${settings}export const ${name} = action(t.Object({}), () => '${name}')\n---\n${body}\n`
const ADMINS = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-admin\'))\n    deny(403, \'Admins only\')\n})\n'
const OPEN = 'export const page = { guards: false }\n'

describe('requireGuards', () => {
  let dir = ''
  let required: Awaited<ReturnType<typeof pages>>
  let optional: Awaited<ReturnType<typeof pages>>

  const status = async (app: typeof required, path: string, headers: Record<string, string> = {}) => (await app.handle(new Request(`http://localhost${path}`, { headers }))).status
  const post = async (file: string, name: string, headers: Record<string, string> = {}, app = required) => {
    const response = await app.handle(new Request(`http://localhost/_kay/action/${relative(process.cwd(), join(dir, 'routes'))}/${file}/${name}`, {
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
      // A layout whose only page is open still puts its actions behind its directory's guards.
      Bun.write(join(dir, 'routes/staff/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'routes/staff/_layout.kay'), ACTION('promote', '', 'slot')),
      Bun.write(join(dir, 'routes/staff/sign-in.kay'), `--- server\n${OPEN}---\nh1 Staff sign in\n`),
      Bun.write(join(dir, 'routes/news/_layout.kay'), ACTION('subscribe', '', 'slot')),
      Bun.write(join(dir, 'routes/news/index.kay'), `--- server\n${OPEN}---\nh1 News\n`),
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

  it('runs a layout\'s own directory guards for its actions, whichever page the scan met it under', async () => {
    expect(await post('staff/_layout.kay', 'promote')).toBe(403)
    expect(await post('staff/_layout.kay', 'promote', { 'x-admin': '1' })).toBe(200)
    expect(await post('staff/_layout.kay', 'promote', {}, optional)).toBe(403)
    expect(await post('news/_layout.kay', 'subscribe')).toBe(403)
    expect(await post('news/_layout.kay', 'subscribe', {}, optional)).toBe(200)
  })

  it('keeps an endpoint no guard covers out of a static export', async () => {
    const endpoints = await scanEndpoints(join(dir, 'routes'))

    expect(await exportedEndpoints(dir, endpoints, true)).toEqual({ paths: ['/status.json'], problems: ['routes/feed.json.ts: requireGuards is on and no guard covers it; set `guards: false` in `export const page` to export it'] })
    expect((await exportedEndpoints(dir, endpoints)).paths.sort()).toEqual(['/feed.json', '/status.json'])
  })

  it('is reported by kay check, route by route, layouts with actions included', async () => {
    const reported = async (requireGuards: boolean) => (await writeShadowTypes(dir, { routes: 'routes', api: 'api', requireGuards })).problems.filter(found => found.code === 'unguarded-route').map(found => [relative(dir, found.file), found.message])

    expect(await reported(true)).toEqual([
      ['routes/index.kay', 'No guard covers `/`, so the server refuses it'],
      ['routes/_layout.kay', 'No guard covers the actions of this layout, `leave`, so the server refuses them'],
      ['routes/news/_layout.kay', 'No guard covers the actions of this layout, `subscribe`, so the server refuses them'],
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

describe('input a guarded route\'s schema refuses', () => {
  const NAMED = '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const rename = action(t.Object({ name: t.String({ maxLength: 3 }) }), input => input.name)\n---\nh1 Admin\n'
  const BROKEN = 'import { guard } from \'kay\'\n\nexport default guard(({ locals }) => {\n  if ((locals as { user?: { id: string } }).user!.id === \'\')\n    throw new Error(\'no user\')\n})\n'
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  const act = async (folder: string, headers: Record<string, string> = {}, form = false) => {
    const response = await app.handle(new Request(`http://localhost/_kay/action/${relative(process.cwd(), join(dir, 'routes'))}/${folder}/index.kay/rename`, {
      method: 'POST',
      headers: { referer: `http://localhost/${folder}`, ...form ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': 'application/json', 'x-kay-action': '1' }, ...headers },
      body: form ? 'name=secret-value' : stringify({ name: 'secret-value' }),
    }))

    return { status: response.status, body: await response.text() }
  }
  const call = async (headers: Record<string, string> = {}) => {
    const response = await app.handle(new Request('http://localhost/api/admin', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'secret-value' }) }))

    return { status: response.status, body: await response.text() }
  }

  beforeAll(async () => {
    dir = await scratchDir('guards-first-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n'),
      Bun.write(join(dir, 'routes/admin/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'routes/admin/index.kay'), NAMED),
      Bun.write(join(dir, 'routes/broken/_guard.ts'), BROKEN),
      Bun.write(join(dir, 'routes/broken/index.kay'), NAMED),
      Bun.write(join(dir, 'api/owned/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'api/owned/index.ts'), 'import { t } from \'elysia\'\nimport { api } from \'kay/server\'\n\nexport default api().onError(({ code }) => code === \'VALIDATION\' ? new Response(\'own\', { status: 400 }) : undefined).post(\'/\', ({ body }) => body.name, { body: t.Object({ name: t.String({ maxLength: 3 }) }) })\n'),
      Bun.write(join(dir, 'api/counted/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(({ headers }) => {\n  const runs = (globalThis as { guardRuns?: number }).guardRuns = ((globalThis as { guardRuns?: number }).guardRuns ?? 0) + 1\n\n  headers.set(\'x-runs\', String(runs))\n})\n'),
      Bun.write(join(dir, 'api/counted/index.ts'), 'import { t } from \'elysia\'\nimport { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'text\' as unknown as number, { response: t.Number() })\n'),
      Bun.write(join(dir, 'api/admin/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'api/admin/index.ts'), 'import { t } from \'elysia\'\nimport { api } from \'kay/server\'\n\nexport default api().post(\'/\', ({ body }) => body.name, { body: t.Object({ name: t.String({ maxLength: 3 }) }) })\n'),
    ])
    app = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: false })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('answers an action\'s caller the guards refuse with their refusal, never the field errors and values', async () => {
    expect(await act('admin')).toEqual({ status: 403, body: 'Admins only' })
    expect((await act('admin', {}, true)).status).toBe(403)

    const admitted = await act('admin', { 'x-admin': '1' })

    expect(admitted.status).toBe(422)
    expect(admitted.body).toContain('name')
  })

  it('answers an API route\'s caller the guards refuse with their refusal, never the validation error', async () => {
    expect(await call()).toEqual({ status: 403, body: 'Admins only' })
    expect((await call({ 'x-admin': '1' })).status).toBe(422)
  })

  it('answers before the module\'s own onError, and leaves a response its schema refuses to it once the guards let the caller through', async () => {
    const owned = async (headers: Record<string, string> = {}) => app.handle(new Request('http://localhost/api/owned', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'secret-value' }) }))

    expect((await owned()).status).toBe(403)
    expect(await (await owned({ 'x-admin': '1' })).text()).toBe('own')

    const before = (globalThis as { guardRuns?: number }).guardRuns ?? 0
    const counted = await app.handle(new Request('http://localhost/api/counted'))

    expect(counted.status).not.toBe(200)
    expect((globalThis as { guardRuns?: number }).guardRuns).toBe(before + 1)
  })

  it('gives the field errors when a guard throws for want of a value set up after the schema', async () => {
    expect((await act('broken')).status).toBe(422)
  })
})

describe('the OpenAPI document on a site requiring guards', () => {
  let dir = ''

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('stays behind the guards the guarded modules share, an open module aside', async () => {
    dir = await scratchDir('openapi-guards-')
    await Promise.all([
      Bun.write(join(dir, 'routes/index.kay'), `--- server\n${OPEN}---\nh1 Home\n`),
      Bun.write(join(dir, 'api/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'api/notes.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => [])\n'),
      Bun.write(join(dir, 'api/health.ts'), 'import { api } from \'kay/server\'\n\nexport default api({ guards: false }).get(\'/\', () => \'up\')\n'),
    ])
    const app = await pages({ routes: join(dir, 'routes'), api: join(dir, 'api'), prebuilt: false, requireGuards: true, openapi: true })
    const status = async (headers: Record<string, string> = {}) => (await app.handle(new Request('http://localhost/api/openapi.json', { headers }))).status

    expect(await status()).toBe(403)
    expect(await status({ 'x-admin': '1' })).toBe(200)
  })

  it('stays behind the guards of a library\'s modules, which a library leaves open, and is served when every module is open', async () => {
    const lib = join(dir, 'lib/api')
    const LIB_GUARD = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-lib\'))\n    deny(403)\n})\n'

    await Promise.all([
      Bun.write(join(lib, '_guard.ts'), LIB_GUARD),
      Bun.write(join(lib, 'm.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'m\')\n'),
      Bun.write(join(dir, 'open-api/health.ts'), 'import { api } from \'kay/server\'\n\nexport default api({ guards: false }).get(\'/\', () => \'up\')\n'),
    ])
    const extensions = [{ name: 'lib', api: { dir: lib, prefix: 'lib' } }]
    const status = async (app: Awaited<ReturnType<typeof pages>>, headers: Record<string, string> = {}) => (await app.handle(new Request('http://localhost/api/openapi.json', { headers }))).status

    for (const requireGuards of [false, true]) {
      const app = await pages({ routes: join(dir, 'routes'), api: join(dir, 'none'), prebuilt: false, requireGuards, openapi: true, extensions })

      expect(await status(app)).toBe(403)
      expect(await status(app, { 'x-lib': '1' })).toBe(200)
    }

    expect(await status(await pages({ routes: join(dir, 'routes'), api: join(dir, 'open-api'), prebuilt: false, requireGuards: true, openapi: true }))).toBe(200)
  })

  it('stays refused with a library\'s modules under guards of their own beside an open module, and with no module at all', async () => {
    const guarded = (name: string) => `import { guard } from 'kay'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has('x-${name}'))\n    deny(403)\n})\n`
    const lib = join(dir, 'two/api')

    await Promise.all([
      Bun.write(join(lib, 'a/_guard.ts'), guarded('a')),
      Bun.write(join(lib, 'a/m.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'a\')\n'),
      Bun.write(join(lib, 'b/_guard.ts'), guarded('b')),
      Bun.write(join(lib, 'b/m.ts'), 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', () => \'b\')\n'),
    ])
    const extensions = [{ name: 'two', api: { dir: lib, prefix: 'two' } }]
    const status = async (api: string, more = extensions) => (await (await pages({ routes: join(dir, 'routes'), api: join(dir, api), prebuilt: false, requireGuards: true, openapi: true, extensions: more })).handle(new Request('http://localhost/api/openapi.json'))).status

    expect(await status('open-api')).toBe(403)
    expect(await status('none', [])).toBe(403)
  })
})

describe('falseKeys', () => {
  it('reads the keys of the page object set to false, quoted or not, and none nested in a value or a comment', () => {
    expect(falseKeys('export const page = {\n  \'layouts\': false, guards: false,\n  sitemap: { guards: false },\n  // noindex: false\n}\n')).toEqual(new Set(['layouts', 'guards']))
    expect(falseKeys('export const page = { guards: falsey }\n')).toEqual(new Set())
    expect(falseKeys('const other = { guards: false }\n')).toEqual(new Set())
    expect(falseKeys('export default api({ cors: { origins: [] }, guards: false })\n', /\bapi\s*\(\s*\{/)).toEqual(new Set(['guards']))
  })

  it('reads only a literal false, not an expression starting with it, past any comment between', () => {
    expect(falseKeys('export const page = { guards: false || open, layouts: false ? 1 : 2, noindex: false // why\n, sitemap: false }\n')).toEqual(new Set(['noindex', 'sitemap']))
    expect(falseKeys('export const page = { guards: false /* x */ || open, layouts: false // note\n && open, sitemap: False, noindex: false /* last */ }\n')).toEqual(new Set(['noindex']))
  })

  it('skips a page object written in a comment, a string or a template literal', () => {
    expect(falseKeys('/*\nexport const page = { guards: false }\n*/\nexport const page = { layouts: false }\n')).toEqual(new Set(['layouts']))
    expect(falseKeys('const doc = `\nexport const page = { guards: false }\n${`\n`}`\n')).toEqual(new Set())
    expect(falseKeys('const doc = `${"`"}\nexport const page = { guards: false }\n`\nexport const page = { sitemap: false }\n')).toEqual(new Set(['sitemap']))
  })
})
