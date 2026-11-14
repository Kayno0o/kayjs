import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { falseKeys, ownGuards, unreadSettings } from '../src/server/route-settings'
import { scanEndpoints, scanRoutes } from '../src/server/routes'
import { scratchBuild } from './prerendered'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

// Every route kind answers `guards` as one rule: `false` runs none of the guards above it, a guard, a list or `{ load }` runs after them, outermost first.
const ADMINS = 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-admin\'))\n    deny(403, \'Admins only\')\n\n  return { admin: \'root\' }\n})\n'
const KEYS = 'import { guard } from \'kay\'\n\nexport const needsKey = guard(({ request, deny, guard: above }) => {\n  if (request.headers.get(\'x-key\') !== \'open\')\n    deny(403, \'Key needed\')\n\n  return { key: `key of ${above.admin ?? \'nobody\'}` }\n})\n\nexport const needsTeam = guard(({ request, deny, guard: above }) => {\n  if (!request.headers.has(\'x-team\'))\n    deny(403, \'Team needed\')\n\n  return { team: above.key }\n})\n'
const PAGE = (settings: string, body = 'p ok', code = '') => `--- server\nimport { needsKey, needsTeam } from '../../lib/keys'\n\nexport const page = { ${settings} }\n${code}---\n${body}\n`
const ACTION = (settings: string, up = '../..') => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\nimport { needsKey } from '${up}/lib/keys'\n\nexport const page = { ${settings} }\nexport const rename = action(t.Object({}), () => 'renamed')\n---\np actions\n`
const ENDPOINT = (settings: string) => `import { needsKey, needsTeam } from '../../lib/keys'\n\nexport const page = { ${settings} }\n\nexport function GET({ guard }: { guard: { key?: string, team?: string } }) {\n  return JSON.stringify(guard)\n}\n`
const API = (settings: string, up = '../..') => `import { api } from 'kay/server'\nimport { needsKey, needsTeam } from '${up}/lib/keys'\n\nexport default api({ ${settings} }).get('/', ({ guard }) => guard)\n`

describe('the guards of a route', () => {
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>
  let closed: Awaited<ReturnType<typeof pages>>

  const status = async (path: string, headers: Record<string, string> = {}, site = app) => (await site.handle(new Request(`http://localhost${path}`, { headers }))).status
  const body = async (path: string, headers: Record<string, string> = {}) => (await app.handle(new Request(`http://localhost${path}`, { headers }))).text()
  const post = async (file: string, headers: Record<string, string> = {}) => (await app.handle(new Request(`http://localhost/_kay/action/routes/${file}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/', ...headers },
    body: stringify({}),
  }))).status

  const ADMIN = { 'x-admin': '1' }
  const KEY = { 'x-admin': '1', 'x-key': 'open' }
  const TEAM = { ...KEY, 'x-team': '1' }

  beforeAll(async () => {
    dir = await scratchDir('route-guards-')
    await Promise.all([
      Bun.write(join(dir, 'lib/keys.ts'), KEYS),
      Bun.write(join(dir, 'routes/admin/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'routes/admin/plain.kay'), PAGE('', 'p plain')),
      Bun.write(join(dir, 'routes/admin/open.kay'), PAGE('guards: false')),
      Bun.write(join(dir, 'routes/admin/one.kay'), PAGE('guards: needsKey')),
      Bun.write(join(dir, 'routes/admin/list.kay'), PAGE('guards: [needsKey, needsTeam]', 'p.seen {seen}', 'const seen = JSON.stringify(ctx.guard)\n')),
      Bun.write(join(dir, 'routes/admin/lazy.kay'), PAGE('guards: { load: async () => (await import(\'../../lib/keys\')).needsKey }')),
      Bun.write(join(dir, 'routes/admin/inline.kay'), PAGE('guards: ({ request, deny }) => { if (!request.headers.has(\'x-inline\')) deny(403) }')),
      Bun.write(join(dir, 'routes/admin/acts.kay'), ACTION('guards: needsKey')),
      Bun.write(join(dir, 'routes/admin/slot/_layout.kay'), ACTION('guards: needsKey', '../../..').replace('p actions', 'slot')),
      Bun.write(join(dir, 'routes/admin/slot/index.kay'), 'p slotted\n'),
      Bun.write(join(dir, 'routes/admin/flag.kay'), '--- server\nconst open = false\nexport const page = { guards: open }\n---\np flag\n'),
      Bun.write(join(dir, 'routes/admin/plain.json.ts'), ENDPOINT('')),
      Bun.write(join(dir, 'routes/admin/open.json.ts'), ENDPOINT('guards: false')),
      Bun.write(join(dir, 'routes/admin/list.json.ts'), ENDPOINT('guards: [needsKey, needsTeam]')),
      Bun.write(join(dir, 'routes/loose/index.kay'), PAGE('guards: needsKey')),
      Bun.write(join(dir, 'routes/index.kay'), 'p home\n'),
      Bun.write(join(dir, 'api/admin/_guard.ts'), ADMINS),
      Bun.write(join(dir, 'api/admin/plain.ts'), API('')),
      Bun.write(join(dir, 'api/admin/open.ts'), API('guards: false')),
      Bun.write(join(dir, 'api/admin/one.ts'), API('guards: needsKey')),
      Bun.write(join(dir, 'api/admin/list.ts'), API('guards: [needsKey, needsTeam]')),
      Bun.write(join(dir, 'api/admin/lazy.ts'), API('guards: { load: () => needsKey }')),
      Bun.write(join(dir, 'api/loose.ts'), API('guards: needsKey', '..')),
    ])
    app = await pages({ root: dir, dirs: { routes: 'routes', api: 'api' }, prebuilt: false })
    closed = await pages({ root: dir, dirs: { routes: 'routes', api: 'api' }, prebuilt: false, guards: { default: 'closed' } })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('keeps the guards above a route that lists none', async () => {
    expect(await status('/admin/plain')).toBe(403)
    expect(await status('/admin/plain', ADMIN)).toBe(200)
    expect(await status('/admin/plain.json')).toBe(403)
    expect(await status('/api/admin/plain')).toBe(403)
  })

  it('skips every guard above a route that sets guards: false, whatever its kind', async () => {
    expect(await status('/admin/open')).toBe(200)
    expect(await status('/admin/open.json')).toBe(200)
    expect(await status('/api/admin/open')).toBe(200)
  })

  it('adds a guard or a list to the guards above a page, outermost first', async () => {
    expect(await status('/admin/one')).toBe(403)
    expect(await status('/admin/one', { 'x-key': 'open' })).toBe(403)
    expect(await status('/admin/one', ADMIN)).toBe(403)
    expect(await status('/admin/one', KEY)).toBe(200)
    expect(await status('/admin/list', KEY)).toBe(403)
    expect(await status('/admin/list', TEAM)).toBe(200)
    expect(await body('/admin/list', TEAM)).toContain('{"admin":"root","key":"key of root","team":"key of root"}')
    expect(await status('/admin/lazy', ADMIN)).toBe(403)
    expect(await status('/admin/lazy', KEY)).toBe(200)
    expect(await status('/admin/inline', ADMIN)).toBe(403)
    expect(await status('/admin/inline', { ...ADMIN, 'x-inline': '1' })).toBe(200)
  })

  it('adds a list to the guards above an endpoint', async () => {
    expect(await status('/admin/list.json', ADMIN)).toBe(403)
    expect(await status('/admin/list.json', KEY)).toBe(403)
    expect(await status('/admin/list.json', TEAM)).toBe(200)
    expect(await body('/admin/list.json', TEAM)).toBe('{"admin":"root","key":"key of root","team":"key of root"}')
  })

  it('adds a guard, a list or { load } to the guards above an API module', async () => {
    expect(await status('/api/admin/one', ADMIN)).toBe(403)
    expect(await status('/api/admin/one', KEY)).toBe(200)
    expect(await status('/api/admin/list', KEY)).toBe(403)
    expect(await status('/api/admin/list', TEAM)).toBe(200)
    expect(await body('/api/admin/list', TEAM)).toBe('{"admin":"root","key":"key of root","team":"key of root"}')
    expect(await status('/api/admin/lazy', ADMIN)).toBe(403)
    expect(await status('/api/admin/lazy', KEY)).toBe(200)
  })

  it('runs the list of a page for its actions, and the list of a layout for its own', async () => {
    expect(await post('admin/acts.kay', ADMIN)).toBe(403)
    expect(await post('admin/acts.kay', KEY)).toBe(200)
    expect(await post('admin/slot/_layout.kay', ADMIN)).toBe(403)
    expect(await post('admin/slot/_layout.kay', KEY)).toBe(200)
    // The layout's list is for its actions: the pages under it keep the guards above them.
    expect(await status('/admin/slot', ADMIN)).toBe(200)
  })

  it('covers a route no folder guards, so a site closing the rest answers it', async () => {
    expect(await status('/loose', {}, closed)).toBe(403)
    expect(await status('/loose', { 'x-key': 'open', 'x-admin': '1' }, closed)).toBe(200)
    expect(await status('/api/loose', {}, closed)).toBe(403)
    expect(await status('/api/loose', KEY, closed)).toBe(200)
    expect(await status('/', {}, closed)).toBe(403)
  })

  it('refuses a guards value that is no guard when the route is asked for', async () => {
    expect(await status('/admin/flag', ADMIN)).toBe(500)
  })
})

describe('reading the guards of a route from its source', () => {
  it.each([
    ['a guard', 'export const page = { guards: needsKey }', true],
    ['a list', 'export const page = { guards: [a, b] }', true],
    ['a lazy guard', 'export const page = { guards: { load: () => a } }', true],
    ['an arrow function', 'export const page = { guards: ({ deny }) => deny(403) }', true],
    ['a call', 'export const page = { guards: all(a, b) }', true],
    ['a shorthand', 'export const page = { guards }', true],
    ['a quoted key', 'export const page = { \'guards\': [a] }', true],
    ['false', 'export const page = { guards: false }', false],
    ['true', 'export const page = { guards: true }', false],
    ['no guards', 'export const page = { layouts: false }', false],
    ['a nested key of the same name', 'export const page = { sitemap: { guards: [a] } }', false],
    ['a negation, which kay reports', 'export const page = { guards: !open }', false],
    ['a page in a comment', '// export const page = { guards: [a] }', false],
  ])('finds %s', (_name, source, own) => {
    expect(ownGuards(source)).toBe(own)
    expect(falseKeys(source).has('guards')).toBe(source.includes('guards: false'))
  })

  it('reports a guards value that is a boolean in disguise, not a guard', () => {
    expect(unreadSettings('export const page = { guards: (false) }').map(found => found.key)).toEqual(['guards'])
    expect(unreadSettings('export const page = { guards: false || a }').map(found => found.key)).toEqual(['guards'])
    expect(unreadSettings('export const page = { guards: [a], layouts: false }')).toEqual([])
  })

  it('marks the scan of a page, a layout and an endpoint that list guards', async () => {
    const dir = await scratchDir('route-guards-scan-')

    try {
      await Promise.all([
        Bun.write(join(dir, 'routes/_guard.ts'), ADMINS),
        Bun.write(join(dir, 'routes/page.kay'), PAGE('guards: [a]')),
        Bun.write(join(dir, 'routes/_layout.kay'), 'slot\n'),
        Bun.write(join(dir, 'routes/feed.json.ts'), ENDPOINT('guards: [a]')),
      ])

      const [route] = await scanRoutes(join(dir, 'routes'))
      const [endpoint] = await scanEndpoints(join(dir, 'routes'))

      expect(route?.guards.map(guard => guard.own === true)).toEqual([false, true])
      expect(endpoint?.guards.map(guard => guard.own === true)).toEqual([false, true])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('pages importChecked must still serve', () => {
  it('serves a page with guards: false, a typed page with none, and a layout with guards of its own', async () => {
    const dir = await scratchDir('route-guards-served-')

    await Promise.all(Object.entries({
      'lib/keys.ts': KEYS,
      'routes/open.kay': '--- server\nexport const page = { guards: false }\n---\np open\n',
      'routes/typed.kay': '--- server\nimport type { PageSettings } from \'kay\'\n\nexport const page: PageSettings = { layouts: true }\n---\np typed\n',
      'routes/area/_layout.kay': '--- server\nimport { needsKey } from \'../../lib/keys\'\n\nexport const page = { guards: needsKey }\n---\nslot\n',
      'routes/area/index.kay': 'p area\n',
    }).map(async ([file, text]) => Bun.write(join(dir, file), text)))

    try {
      const app = await pages({ root: dir, dirs: { routes: 'routes', api: 'api' }, prebuilt: false })

      for (const path of ['/open', '/typed', '/area'])
        expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(200)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('guards the scan cannot see in the source', () => {
  const root = async (files: Record<string, string>) => {
    const dir = await scratchDir('route-guards-unseen-')

    await Promise.all(Object.entries({ 'lib/keys.ts': KEYS, ...files }).map(async ([file, text]) => Bun.write(join(dir, file), text)))

    return dir
  }

  it('refuses a page whose settings are typed, never serves it with none of its guards', async () => {
    const dir = await root({ 'routes/index.kay': '--- server\nimport type { PageSettings } from \'kay\'\nimport { needsKey } from \'../lib/keys\'\n\nexport const page: PageSettings = { guards: needsKey }\n---\np secret\n' })

    try {
      const app = await pages({ root: dir, dirs: { routes: 'routes', api: 'api' }, prebuilt: false })

      expect((await app.handle(new Request('http://localhost/'))).status).toBe(500)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stops the boot on an endpoint or an API module whose guards are held in a variable', async () => {
    const endpoint = await root({ 'routes/feed.json.ts': 'import { needsKey } from \'../lib/keys\'\n\nconst settings = { guards: needsKey }\nexport const page = settings\n\nexport function GET() {\n  return \'x\'\n}\n' })
    const module = await root({ 'api/notes.ts': 'import { api } from \'kay/server\'\nimport { needsKey } from \'../lib/keys\'\n\nconst options = { guards: needsKey }\n\nexport default api(options).get(\'/\', () => [])\n' })

    try {
      await expect(pages({ root: endpoint, dirs: { routes: 'routes', api: 'api' }, prebuilt: false })).rejects.toThrow('are not written where kay reads them')
      await expect(pages({ root: module, dirs: { routes: 'routes', api: 'api' }, prebuilt: false })).rejects.toThrow('are not written where kay reads them')
    }
    finally {
      await Promise.all([endpoint, module].map(async dir => rm(dir, { recursive: true, force: true })))
    }
  })

  it('refuses to export a page that lists guards, as for one a _guard.ts covers', async () => {
    const routes = join(await root({ 'routes/index.kay': PAGE('guards: needsKey', 'h1 Home').replace('../../lib', '../lib') }), 'routes')
    const build = await scratchBuild({ dirs: { routes } })

    try {
      await expect(build.prerender({ dirs: { routes }, requireGuards: false }, { exportAll: true })).rejects.toThrow('a guard covers it')
    }
    finally {
      await build.remove()
    }
  })
})
