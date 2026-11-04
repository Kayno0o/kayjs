import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { stringify } from 'devalue'
import { forgetOnces, onceForRequest } from '../src/server/request-scope'
import { kayCheck } from './check-helper'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const TIMEOUT = 120_000
const GUARD = (body: string) => `import { guard } from 'kay'\n\nexport default guard(${body})\n`
// Every load counts into `globalThis.loads`, so a test reads how often a keyed load ran for a request.
const COUNT = 'const counts = (globalThis as { loads?: Record<string, number> }).loads ??= {}\n'

describe('what a guard hands on', () => {
  let dir = ''
  let app: Awaited<ReturnType<typeof pages>>

  const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))
  const text = async (path: string, headers: Record<string, string> = {}) => (await get(path, headers)).text()

  beforeAll(async () => {
    dir = await scratchDir('guard-values-')
    await Promise.all([
      Bun.write(join(dir, 'routes/_guard.ts'), GUARD('async ({ request }) => ({ who: request.headers.get(\'x-who\') ?? \'nobody\', shared: \'outer\' })')),
      Bun.write(join(dir, 'routes/_layout.kay'), '--- server\nconst who = (ctx as any).guard.who\n---\nheader\n  p.layout {who}\nslot\n'),
      Bun.write(join(dir, 'routes/index.kay'), '--- server\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      // A guard below reads what the one above handed on, and wins a key they share.
      Bun.write(join(dir, 'routes/inner/_guard.ts'), GUARD('({ guard }) => ({ shared: `inner after ${(guard as { shared: string }).shared}`, extra: 1 })')),
      Bun.write(join(dir, 'routes/inner/index.kay'), '--- server\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      // Returned values that are not plain objects hand nothing on.
      Bun.write(join(dir, 'routes/odd/_guard.ts'), GUARD('() => new (class Holder { value = 1 })()')),
      Bun.write(join(dir, 'routes/odd/index.kay'), '--- server\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      Bun.write(join(dir, 'routes/arr/_guard.ts'), GUARD('() => [1, 2]')),
      Bun.write(join(dir, 'routes/arr/index.kay'), '--- server\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      Bun.write(join(dir, 'routes/prim/_guard.ts'), GUARD('() => \'text\'')),
      Bun.write(join(dir, 'routes/prim/index.kay'), '--- server\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      Bun.write(join(dir, 'routes/hostile/_guard.ts'), GUARD('() => JSON.parse(\'{"__proto__":{"polluted":true},"ok":1}\')')),
      Bun.write(join(dir, 'routes/hostile/index.kay'), '--- server\nconst seen = JSON.stringify({ own: Object.keys(ctx.guard), polluted: ({} as any).polluted === true, proto: Object.getPrototypeOf(ctx.guard) === Object.prototype })\n---\np.page {seen}\n'),
      // An open page runs none of the guards above it, so it hands nothing on.
      Bun.write(join(dir, 'routes/open.kay'), '--- server\nexport const page = { guards: false }\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      Bun.write(join(dir, 'routes/denied/_guard.ts'), GUARD('({ deny }) => deny(403, \'No\')')),
      Bun.write(join(dir, 'routes/denied/index.kay'), '--- server\nconst seen = JSON.stringify(ctx.guard)\n---\np.page {seen}\n'),
      Bun.write(join(dir, 'routes/acts/index.kay'), '--- server\nimport { action } from \'kay\'\n\nexport const who = action((ctx) => (ctx as any).guard.who as string)\n---\nh1 Acts\n'),
      Bun.write(join(dir, 'routes/ends.json.ts'), 'export function GET(ctx: { guard: object }) {\n  return JSON.stringify(ctx.guard)\n}\n'),
      // Loads of the layout and the page, which run at once, share one keyed load.
      Bun.write(join(dir, 'routes/memo/_layout.kay'), `--- server\n${COUNT}const org = await ctx.once('org', async () => { counts.org = (counts.org ?? 0) + 1; await Bun.sleep(20); return { name: ctx.request.headers.get('x-org') ?? 'none' } })\n---\nheader\n  p.layout {org.name}\nslot\n`),
      Bun.write(join(dir, 'routes/memo/index.kay'), `--- server\n${COUNT}const org = await ctx.once('org', async () => { counts.org = (counts.org ?? 0) + 1; return { name: 'second' } })\nconst other = await ctx.once('other', () => { throw new Error('boom') }).catch(() => 'failed')\nconst again = await ctx.once('other', () => 'never').catch(() => 'failed again')\n---\np.page {org.name} {other} {again} {counts.org}\n`),
      Bun.write(join(dir, 'api/_guard.ts'), GUARD('({ request }) => ({ who: request.headers.get(\'x-who\') ?? \'nobody\' })')),
      Bun.write(join(dir, 'api/me.ts'), 'import { api } from \'kay/server\'\n\nexport default api<{ who: string }>()\n  .get(\'/\', async ({ guard, once }) => ({ who: guard.who, again: await once(\'k\', () => guard.who) === await once(\'k\', () => \'other\') }))\n'),
      Bun.write(join(dir, 'api/open.ts'), 'import { api } from \'kay/server\'\n\nexport default api({ guards: false })\n  .get(\'/\', ({ guard }) => ({ keys: Object.keys(guard) }))\n'),
    ])
    app = await pages({ root: dir, dirs: { routes: 'routes' }, api: 'api', prebuilt: false })
  })

  afterAll(async () => rm(dir, { recursive: true, force: true }))

  it('reaches the layout and the page below it as ctx.guard', async () => {
    const html = await text('/', { 'x-who': 'ada' })

    expect(html).toContain('<p class="layout">ada</p>')
    expect(html).toContain('{"who":"ada","shared":"outer"}')
  })

  it('merges the guards outermost first, a guard below reading what the one above handed on and winning a shared key', async () => {
    const html = await text('/inner', { 'x-who': 'ada' })

    expect(html).toContain('"shared":"inner after outer"')
    expect(html).toContain('"extra":1')
    expect(html).toContain('"who":"ada"')
  })

  it('hands on nothing from a guard returning an object that is not plain', async () => {
    expect(await text('/odd')).toContain('{"who":"nobody","shared":"outer"}')
  })

  it('hands on nothing from a guard returning an array or a primitive', async () => {
    expect(await text('/arr')).toContain('<p class="page">{"who":"nobody","shared":"outer"}</p>')
    expect(await text('/prim')).toContain('<p class="page">{"who":"nobody","shared":"outer"}</p>')
  })

  it('forgets the answers of a request when it renders again', async () => {
    const request = new Request('http://localhost/memo-reset')
    let loads = 0
    const load = () => ++loads

    expect(await onceForRequest(request, 'k', load)).toBe(1)
    expect(await onceForRequest(request, 'k', load)).toBe(1)
    forgetOnces(request)
    expect(await onceForRequest(request, 'k', load)).toBe(2)
  })

  it('keeps a hostile __proto__ key from reaching any prototype', async () => {
    const html = await text('/hostile')

    expect(html).toContain('polluted":false')
    expect(html).toContain('proto":true')
    expect(html).toContain('__proto__')
  })

  it('shares nothing between two requests running at once', async () => {
    const answers = await Promise.all(['ada', 'bob', 'cy', 'di'].map(async who => text('/', { 'x-who': who })))

    for (const [index, who] of ['ada', 'bob', 'cy', 'di'].entries())
      expect(answers[index]).toContain(`<p class="layout">${who}</p>`)
  })

  it('is empty on a page that sets guards: false', async () => {
    expect(await text('/open')).toContain('p class="page">{}')
  })

  it('renders nothing of the page when a guard refuses', async () => {
    const response = await get('/denied')

    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('class="page"')
  })

  it('reaches an action and an endpoint', async () => {
    const response = await app.handle(new Request('http://localhost/_kay/action/routes/acts/index.kay/who', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/acts', 'x-who': 'ada' },
      body: stringify({}),
    }))

    expect(await response.text()).toContain('ada')
    expect(await text('/ends.json', { 'x-who': 'bob' })).toBe('{"who":"bob","shared":"outer"}')
  })

  it('reaches an API route as ctx.guard and ctx.once, empty on a module with guards: false', async () => {
    expect(await (await get('/api/me', { 'x-who': 'cy' })).json()).toEqual({ who: 'cy', again: true })
    expect(await (await get('/api/open', { 'x-who': 'cy' })).json()).toEqual({ keys: [] })
  })

  it('shares a keyed load between the layout and the page of one request, and across none', async () => {
    const counts = (globalThis as { loads?: Record<string, number> }).loads ??= {}

    counts.org = 0

    const html = await text('/memo', { 'x-org': 'acme' })

    expect(html).toContain('<p class="layout">acme</p>')
    expect(html).toContain('acme failed failed again 1')

    await text('/memo', { 'x-org': 'other' })
    expect(counts.org).toBe(2)
  })
})

describe('kay check on ctx.guard', () => {
  const projects: string[] = []

  afterAll(async () => {
    await Promise.all(projects.map(async path => rm(path, { recursive: true, force: true })))
  })

  async function check(files: Record<string, string>): Promise<{ code: number, output: string }> {
    const root = await scratchDir('guard-values-check-')

    projects.push(root)
    await Promise.all(Object.entries({
      'package.json': JSON.stringify({ name: 'app', private: true }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM', 'DOM.Iterable'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
      'kay.config.ts': 'export default {}\n',
      ...files,
    }).map(async ([path, text]) => Bun.write(join(root, path), text)))

    const { code, output, report } = await kayCheck([root])

    return { code, output: `${report}${output}` }
  }

  const ORG = 'import { guard } from \'kay\'\n\nexport default guard(async ({ params }) => ({ org: { id: String(params.org), name: \'Acme\' } }))\n'

  it('types a page, a layout and an action from the guards above them', async () => {
    const { code, output } = await check({
      'src/routes/orgs/[org]/_guard.ts': ORG,
      'src/routes/orgs/[org]/_layout.kay': '--- server\nconst name: string = ctx.guard.org.name\n---\nh1 {name}\nslot\n',
      'src/routes/orgs/[org]/index.kay': '--- server\nimport { action } from \'kay\'\n\nconst id: string = ctx.guard.org.id\nexport const rename = action((ctx) => ctx.guard.org.name)\n---\np {id}\n',
    })

    expect(output).toMatch(/checked with no problems in \d+ ms/)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('types an API route from the guards named by api<...>()', async () => {
    const { code, output } = await check({
      'src/api/_guard.ts': ORG,
      'src/api/org.ts': 'import { api } from \'kay/server\'\n\nexport default api<{ org: { name: string } }>().get(\'/\', ({ guard, once }) => once(\'name\', () => guard.org.name))\n',
      'src/routes/index.kay': 'p Home\n',
    })

    expect(output).toMatch(/checked with no problems in \d+ ms/)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('reports a field no guard returns', async () => {
    const { code, output } = await check({
      'src/routes/orgs/[org]/_guard.ts': ORG,
      'src/routes/orgs/[org]/index.kay': '--- server\nconst nope = ctx.guard.team\n---\np {nope}\n',
    })

    expect(output).toContain('team')
    expect(code).not.toBe(0)
  }, TIMEOUT)

  it('types a guard that may return nothing, and the inner of two guards sharing a key', async () => {
    const { code, output } = await check({
      'src/routes/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request }) => request.headers.has(\'x\') ? { org: 1, shared: \'outer\' } : undefined)\n',
      'src/routes/in/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(() => ({ shared: 2 }))\n',
      'src/routes/in/index.kay': '--- server\nconst org: number = ctx.guard.org\nconst shared: number = ctx.guard.shared\n---\np {org} {shared}\n',
    })

    expect(output).toMatch(/checked with no problems in \d+ ms/)
    expect(code).toBe(0)
  }, TIMEOUT)

  it('refuses ctx.guard on a prerendered page', async () => {
    const { code, output } = await check({
      'src/routes/_guard.ts': ORG,
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\nconst nope = ctx.guard.org\n---\np {String(nope)}\n',
    })

    expect(output).toContain('guard')
    expect(code).not.toBe(0)
  }, TIMEOUT)

  it('reports a read on a page that sets guards: false', async () => {
    const { code, output } = await check({
      'src/routes/_guard.ts': ORG,
      'src/routes/index.kay': '--- server\nexport const page = { guards: false }\nconst nope = ctx.guard.org\n---\np {nope}\n',
    })

    expect(output).toContain('org')
    expect(code).not.toBe(0)
  }, TIMEOUT)
})
