import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { formatRouteTable } from '../src/build/report'
import { compileKay } from '../src/compiler'
import { CONTENT_EXPORTS, KAY_EXPORTS, keptScan } from '../src/server/pure-page'
import { scratchDir } from './scratch'

type Route = Parameters<typeof keptScan>[0]

const keptStop = async (route: Route) => (await keptScan(route)).stop
const readsNothing = async (route: Route) => await keptStop(route) === undefined

const CLI = join(import.meta.dir, '../src/cli.ts')
const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
const PACKAGE_WITH_TABLER = '{ "devDependencies": { "@iconify-json/tabler": "*" } }\n'
const MESSAGES = { fr: 'export default { hello: \'Bonjour\' }\n', en: 'export default { hello: \'Hello\' }\n' }

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('kept-')

  await Promise.all(Object.entries({ 'tsconfig.json': TSCONFIG, 'kay.config.ts': CONFIG, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function built(root: string): Promise<string[]> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`${out}${err}`)

  const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { pages: Record<string, unknown> }

  return Object.keys(manifest.pages).sort()
}

interface Asked {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
  // Milliseconds before the request is sent, to land in the middle of another of its group.
  wait?: number
}

interface Answered {
  status: number
  etag: string | null
  cache: string | null
  text: string
}

// A server of its own on what the build wrote, which the requests go through in order, a group of them together: one process serves one project.
// The warnings it logged come with the answers.
// `parent` is chained onto the app ahead of `pages()`, as hooks of a parent app are.
async function servedWith(root: string, asked: (Asked | Asked[])[], options = '', parent = ''): Promise<{ answers: Answered[], warnings: string }> {
  await Bun.write(join(root, 'serve.ts'), `import { Elysia } from 'elysia'\nimport { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}\n\nconst app = new Elysia()${parent}.use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, log: false, compress: false${options} }))\nconst answers = []\nconst ask = async ({ path, method, headers, body, wait }) => {\n  if (wait)\n    await Bun.sleep(wait)\n\n  const response = await app.handle(new Request(\`http://localhost\${path}\`, { method, headers, body }))\n\n  return { status: response.status, etag: response.headers.get('etag'), cache: response.headers.get('cache-control'), text: await response.text() }\n}\n\nfor (const group of ${JSON.stringify(asked)}) {\n  if (Array.isArray(group))\n    answers.push(...await Promise.all(group.map(ask)))\n  else\n    answers.push(await ask(group))\n}\n\nconsole.log(JSON.stringify(answers))\nprocess.exit(0)\n`)

  const child = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`${out}${err}`)

  const at = out.lastIndexOf('\n[') + 1

  return { answers: JSON.parse(out.slice(at)) as Answered[], warnings: `${out.slice(0, at)}${err}` }
}

async function served(root: string, asked: (Asked | Asked[])[], options = ''): Promise<Answered[]> {
  return (await servedWith(root, asked, options)).answers
}

// The page and what it imports, under src/routes by the page's name.
const KEPT: Record<string, string> = {
  'src/routes/index.kay': 'h1 Home\n',
  'src/routes/island.kay': '---\nimport Counter from \'../counter.kay\'\n---\nCounter\n',
  'src/routes/helper.kay': '---\nimport { shout } from \'../shout\'\n---\np {shout(\'hi\')}\n',
  'src/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
  'src/shout.ts': 'export function shout(text: string): string {\n  return text.toUpperCase()\n}\n',
}
// Each page here depends on its request or the moment in a way its source shows or hides.
const READING: Record<string, string> = {
  'src/routes/ctx.kay': 'p {ctx.url.search}\n',
  'src/routes/query.kay': '--- server\nimport { s } from \'kay\'\n\nexport const page = { query: s.Object({ page: s.Optional(s.Number()) }) }\n---\np Query\n',
  'src/routes/date.kay': 'p {new Date().getFullYear()}\n',
  'src/routes/random.kay': 'p {Math.random()}\n',
  'src/routes/env.kay': 'p {process.env.HOME}\n',
  'src/routes/persisted.kay': '---\nimport { persisted } from \'kay\'\n\nconst theme = persisted(\'theme\', \'light\')\n---\np {theme()}\n',
  'src/routes/package.kay': '---\nimport { sessionOf } from \'kayjs-auth\'\n---\np Package\n',
  'src/routes/server-import.kay': '--- server\nimport { site } from \'kay/server\'\n---\np Server\n',
  'src/routes/state.kay': '---\nimport { next } from \'../counted\'\n---\np {next()}\n',
  'src/routes/closure.kay': '---\nimport { tick } from \'../ticking\'\n---\np {tick()}\n',
  'src/routes/through-component.kay': '---\nimport Clock from \'../clock.kay\'\n---\nClock\n',
  'src/routes/opted-out.kay': '--- server\nexport const page = { prerender: false }\n---\np Opted out\n',
  'src/routes/revalidated.kay': '--- server\nexport const page = { revalidate: \'1h\' }\n---\np Revalidated\n',
  'src/routes/[name].kay': 'p Params\n',
  'src/routes/barrel.kay': '---\nimport { now } from \'../lib\'\n---\np {now()}\n',
  'src/routes/relative.kay': '--- server\nimport { formatRelativeTime } from \'kay/i18n\'\n---\np {formatRelativeTime(1_700_000_000_000)}\n',
  'src/routes/shared.kay': '---\nimport { todos } from \'../todos\'\n---\np {todos.length}\n',
  'src/routes/cache.kay': '---\nimport { lookup } from \'../cache\'\n---\np {lookup(\'a\')}\n',
  'src/routes/database.kay': '---\nimport { rows } from \'../rows\'\n---\np {rows.length}\n',
  'src/lib.ts': 'export * from \'./clock-time\'\n',
  'src/clock-time.ts': 'export function now(): string {\n  return new Date().toISOString()\n}\n',
  'src/todos.ts': 'export const todos: string[] = [\'first\']\n\nexport function add(todo: string): void {\n  todos.push(todo)\n}\n',
  'src/cache.ts': 'const seen = new Map<string, number>()\n\nexport function lookup(key: string): number {\n  seen.set(key, (seen.get(key) ?? 0) + 1)\n\n  return seen.size\n}\n',
  'src/rows.ts': 'import db from \'./app.db\' with { type: \'sqlite\' }\n\nexport const rows = db.query(\'select 1\').all()\n',
  'src/app.db': '',
  'src/clock.kay': 'p {new Date().toISOString()}\n',
  'src/counted.ts': 'let count = 0\n\nexport function next(): number {\n  return ++count\n}\n',
  'src/ticking.ts': 'const calls = { n: 0 }\nconst bump = () => calls.n++\n\nexport function tick(): number {\n  bump()\n\n  return calls.n\n}\n',
}

describe('a page that reads nothing from its request', () => {
  it('is kept by the build, and a page reading anything is not', async () => {
    const root = await project({ ...KEPT, ...READING })

    try {
      expect(await built(root)).toEqual(['/', '/helper', '/island'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('is told from the source alone, layouts and components included', async () => {
    const root = await project({ ...KEPT, 'src/routes/_layout.kay': 'slot\n', 'src/routes/reading/_layout.kay': 'p {ctx.request.url}\nslot\n', 'src/routes/reading/index.kay': 'p Page\n' })

    try {
      const route = (file: string, ...layouts: string[]) => ({ file: join(root, file), layouts: layouts.map(layout => join(root, layout)) })

      expect(await readsNothing(route('src/routes/index.kay', 'src/routes/_layout.kay'))).toBe(true)
      expect(await readsNothing(route('src/routes/reading/index.kay', 'src/routes/_layout.kay', 'src/routes/reading/_layout.kay'))).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is served from the kept copy, revalidated by its tag, behind the guards of its route', async () => {
    const root = await project({
      'src/routes/index.kay': 'h1 Home\n',
      'src/routes/private/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-pass\'))\n    deny(403)\n})\n',
      'src/routes/private/index.kay': 'h1 Private\n',
    })

    try {
      expect(await built(root)).toEqual(['/', '/private'])

      const [home] = await served(root, [{ path: '/' }])
      const [revalidated, refused, allowed] = await served(root, [{ path: '/', headers: { 'if-none-match': home!.etag! } }, { path: '/private' }, { path: '/private', headers: { 'x-pass': '1' } }])

      expect(home!.status).toBe(200)
      expect(home!.cache).toBe('public, max-age=0, must-revalidate')
      expect(home!.text).toContain('Home')
      expect(revalidated!.status).toBe(304)
      expect(refused!.status).toBe(403)
      expect(allowed!.status).toBe(200)
      expect(allowed!.cache).toBe('private, no-cache')
      expect(allowed!.text).toContain('Private')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('is rendered per request in development, where an edit shows at once, whatever an earlier build kept', async () => {
    const root = await project({ 'src/routes/index.kay': 'h1 Before\n' })

    try {
      expect(await built(root)).toEqual(['/'])
      await Bun.write(join(root, 'src/routes/index.kay'), 'h1 After\n')

      const [kept] = await served(root, [{ path: '/' }])
      const [dev] = await served(root, [{ path: '/' }], ', prebuilt: false, dev: true')

      expect(kept!.text).toContain('Before')
      expect(dev!.text).toContain('After')
      expect(dev!.etag).toBeNull()
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('is kept once per locale, under a base and a trailing slash', async () => {
    const root = await project({
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\', trailingSlash: \'always\', i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\', messages: \'src/messages\' } })\n',
      'src/messages/fr.ts': MESSAGES.fr,
      'src/messages/en.ts': MESSAGES.en,
      'src/routes/index.kay': '--- server\nimport { t } from \'kay/i18n\'\n---\nh1 {t(\'hello\')}\na(href="/about") About\n',
      'src/routes/about.kay': '--- server\nimport { t } from \'kay/i18n\'\n---\np {t(\'hello\')} about\n',
    })

    try {
      expect((await built(root)).sort()).toEqual(['/', '/about', '/en', '/en/about'])

      const answers = await served(root, [{ path: '/' }, { path: '/en/' }, { path: '/en/about/' }, { path: '/about/' }])

      expect(answers.map(answer => answer.status)).toEqual([200, 200, 200, 200])
      expect(answers.map(answer => answer.etag !== null)).toEqual([true, true, true, true])
      expect(answers[0]!.text).toContain('Bonjour')
      expect(answers[0]!.text).toContain('href="/app/about"')
      expect(answers[1]!.text).toContain('Hello')
      expect(answers[2]!.text).toContain('Hello about')
      expect(answers[3]!.text).toContain('Bonjour about')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})

interface Tally {
  stable: number
  asked: number
}

const ACTION_HEADERS = { 'content-type': 'application/json', 'x-kay-action': '1', 'referer': 'http://localhost/' }
const post = (file: string, name: string): Asked => ({ path: `/_kay/action/src/routes/${file}/${name}`, method: 'POST', headers: ACTION_HEADERS, body: '[{}]' })
const noise = (path: string): Asked => ({ path, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const read = (path: string, headers?: Record<string, string>): Asked => headers ? { path, headers } : { path }
// The value is built by a call, which the build cannot see an action change; `tally` counts the renders the server makes.
const GUESTBOOK: Record<string, string> = {
  'src/api/notes.ts': 'import { api } from \'kay/server\'\nimport { add } from \'../guestbook\'\n\nexport default api().post(\'/\', () => {\n  add()\n\n  return { ok: true }\n})\n',
  'src/guestbook.ts': 'export const messages = seed()\nexport const counts = tally()\n\nfunction seed(): string[] {\n  return [\'first\']\n}\n\nfunction tally() {\n  return { stable: 0, asked: 0 }\n}\n\nexport function add(): void {\n  messages.push(`m${messages.length}`)\n}\n\nexport function stable(): string {\n  counts.stable++\n\n  return \'Stable\'\n}\n\nexport function asked(): string {\n  counts.asked++\n\n  return messages.join(\',\')\n}\n',
  'src/routes/index.kay': '---\nimport { messages } from \'../guestbook\'\n---\np {messages.join(\',\')}\n',
  'src/routes/about.kay': '---\nimport { stable } from \'../guestbook\'\n---\np {stable()}\n',
  'src/routes/asked.kay': '--- server\nimport { asked } from \'../guestbook\'\n\nexport const page = { prerender: true }\n---\np {asked()}\n',
  'src/routes/add.kay': '--- server\nimport { s } from \'kay\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  add()\n})\n---\nform(action={save}) button Add\n',
  'src/routes/invalidate.kay': '--- server\nimport { s } from \'kay\'\nimport { invalidatePage } from \'kay/cache\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  add()\n  invalidatePage(\'/\')\n})\n---\nform(action={save}) button Invalidate\n',
  'src/routes/slow.kay': '--- server\nimport { s } from \'kay\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  await Bun.sleep(300)\n  add()\n})\n---\nform(action={save}) button Slow\n',
  'src/routes/fail.kay': '--- server\nimport { s } from \'kay\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  add()\n\n  throw new Error(\'boom\')\n})\n---\nform(action={save}) button Fail\n',
  'src/routes/calls.json.ts': 'import { counts } from \'../guestbook\'\n\nexport function GET(): Response {\n  return Response.json(counts)\n}\n',
  'src/routes/private/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-pass\'))\n    deny(403)\n})\n',
  'src/routes/private/index.kay': '---\nimport { messages } from \'../../guestbook\'\n---\np {messages.join(\',\')}\n',
}

const under: Record<string, string> = {
  ...GUESTBOOK,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\', trailingSlash: \'always\', i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\', messages: \'src/messages\' } })\n',
  'src/messages/fr.ts': MESSAGES.fr,
  'src/messages/en.ts': MESSAGES.en,
  'src/routes/index.kay': '--- server\nimport { t } from \'kay/i18n\'\nimport { messages } from \'../guestbook\'\n---\np {t(\'hello\')} {messages.join(\',\')}\n',
}

describe('a kept page after a request that can write', () => {
  const roots: string[] = []

  async function guestbook(files: Record<string, string> = GUESTBOOK): Promise<string> {
    const root = await project(files)

    roots.push(root)
    await built(root)

    return root
  }

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('shows what an action changed on the first visit after it', async () => {
    const root = await guestbook()
    const [before, written, after, again] = await served(root, [read('/'), post('add.kay', 'save'), read('/'), read('/')])

    expect(before!.text).toContain('first<')
    expect(before!.etag).not.toBeNull()
    expect(written!.status).toBeLessThan(400)
    expect(after!.text).toContain('first,m1')
    expect(again!.text).toContain('first,m1')
  }, 120_000)

  it('answers a page that did not change from the kept copy, rendering it once per write', async () => {
    const root = await guestbook()
    const [first, , second, third, , fourth, counts] = await served(root, [read('/about'), post('add.kay', 'save'), read('/about'), read('/about'), post('add.kay', 'save'), read('/about'), read('/calls.json')])

    expect(second!.etag).toBe(first!.etag)
    expect(third!.etag).toBe(first!.etag)
    expect(fourth!.etag).toBe(first!.etag)
    expect((JSON.parse(counts!.text) as Tally).stable).toBe(2)
  }, 120_000)

  it('renders once for two visits racing right after a write', async () => {
    const root = await guestbook()
    const answers = await served(root, [post('add.kay', 'save'), [read('/about'), read('/about'), read('/')], read('/calls.json')])

    expect(answers.slice(1, 4).map(answer => answer.status)).toEqual([200, 200, 200])
    expect(answers[1]!.text).toBe(answers[2]!.text)
    expect(answers[3]!.text).toContain('first,m1')
    expect((JSON.parse(answers[4]!.text) as Tally).stable).toBe(1)
  }, 120_000)

  it('warns once, naming the page and how to opt out', async () => {
    const root = await guestbook()
    const { warnings } = await servedWith(root, [post('add.kay', 'save'), read('/'), post('add.kay', 'save'), read('/'), read('/about')])

    expect(warnings.match(/the page \/ was kept/g)).toHaveLength(1)
    expect(warnings).toContain('prerender: false')
    expect(warnings).not.toContain('/about')
  }, 120_000)

  it('leaves a page the author asked to prerender as it was built', async () => {
    const root = await guestbook()
    const [, , asked, counts] = await served(root, [post('add.kay', 'save'), read('/'), read('/asked'), read('/calls.json')])

    expect(asked!.text).toContain('first<')
    expect((JSON.parse(counts!.text) as Tally).asked).toBe(0)
  }, 120_000)

  it('keeps running the guards of a page that changed', async () => {
    const root = await guestbook()
    const [, refused, allowed, again] = await served(root, [post('add.kay', 'save'), read('/private'), read('/private', { 'x-pass': '1' }), read('/private')])

    expect(refused!.status).toBe(403)
    expect(allowed!.status).toBe(200)
    expect(allowed!.text).toContain('first,m1')
    expect(again!.status).toBe(403)
  }, 120_000)

  it('keeps a page an action refreshed with invalidatePage, without a warning', async () => {
    const root = await guestbook()
    const { answers: [, after, again], warnings } = await servedWith(root, [post('invalidate.kay', 'save'), read('/'), read('/')])

    expect(after!.text).toContain('first,m1')
    expect(again!.text).toContain('first,m1')
    expect(warnings).not.toContain('renders differently')
  }, 120_000)

  it('checks again after a write that failed', async () => {
    const root = await guestbook()
    const [failed, after] = await served(root, [post('fail.kay', 'save'), read('/')])

    expect(failed!.status).toBeGreaterThanOrEqual(500)
    expect(after!.text).toContain('first,m1')
  }, 120_000)

  it('answers HEAD and a conditional request from the page as it is now', async () => {
    const root = await guestbook()
    const [old, stableOld] = await served(root, [read('/'), read('/about')])
    const [, head, conditional, stable, stableHead] = await served(root, [post('add.kay', 'save'), { path: '/', method: 'HEAD' }, read('/', { 'if-none-match': old!.etag! }), read('/about', { 'if-none-match': stableOld!.etag! }), { path: '/about', method: 'HEAD' }])

    expect(head!.status).toBe(200)
    expect(head!.text).toBe('')
    expect(conditional!.status).toBe(200)
    expect(conditional!.text).toContain('first,m1')
    expect(stable!.status).toBe(304)
    expect(stableHead!.status).toBe(200)
  }, 120_000)

  it('is not rechecked after a request no app handler answers', async () => {
    const root = await guestbook()
    const rounds = 5
    const requests: Asked[] = []

    for (let round = 0; round < rounds; round++)
      requests.push(noise('/_kay/analytics'), noise('/_kay/error'), noise('/_kay/csp'), noise('/_kay/analytics/collect'), noise('/_kay/error/'), noise('/_kay/%65rror'), noise('/_kay/analytics?x=1'), noise('/nowhere'), noise('/about'), read('/about'))

    const answers = await served(root, [...requests, read('/calls.json')])
    const counts = JSON.parse(answers.at(-1)!.text) as Tally

    expect(answers.filter((_, at) => at % 10 === 9 && at < rounds * 10).every(answer => answer.status === 200)).toBe(true)
    expect(counts.stable).toBe(0)
  }, 120_000)

  it('is checked again after a write that a visit overlapped', async () => {
    const root = await guestbook()
    const [, , during, after] = await served(root, [read('/'), [post('slow.kay', 'save'), { ...read('/'), wait: 100 }], read('/')])

    expect(during!.text).toContain('first<')
    expect(after!.text).toContain('first,m1')
  }, 120_000)

  it('is checked again after a write whose answer a parent mapResponse replaced', async () => {
    const root = await guestbook()
    // The last visit waits, as Elysia runs afterResponse hooks once the event loop gets to them.
    const parent = '.mapResponse({ as: \'global\' }, ({ request }) => request.method === \'POST\' ? new Response(\'replaced\') : undefined)'
    const { answers: [, , during, after] } = await servedWith(root, [read('/'), [post('slow.kay', 'save'), { ...read('/'), wait: 100 }], { ...read('/'), wait: 50 }], '', parent)

    expect(during!.text).toContain('first<')
    expect(after!.text).toContain('first,m1')
  }, 120_000)

  it('is not rechecked after kay\'s live values stream, whatever the slashes', async () => {
    const root = await guestbook()
    const answers = await served(root, [noise('/_kay/live'), noise('/_kay/live/'), noise(`/_kay/live${'/'.repeat(20_000)}`), noise(`/_kay${'/'.repeat(20_000)}x`), read('/about'), read('/calls.json')])

    expect((JSON.parse(answers.at(-1)!.text) as Tally).stable).toBe(0)
  }, 120_000)

  it('is not rechecked after the MCP endpoint, whatever its path or slashes', async () => {
    const root = await guestbook()
    const answers = await served(root, [noise('/mcp'), noise('/mcp/'), noise('/tools/'), read('/about'), read('/calls.json')], ', mcp: { path: \'/tools\' }')

    expect((JSON.parse(answers.at(-1)!.text) as Tally).stable).toBe(0)
  }, 120_000)

  it('is rechecked after an API write', async () => {
    const root = await guestbook()
    const [, written, after] = await served(root, [read('/'), noise('/api/notes'), read('/')])

    expect(written!.status).toBe(200)
    expect(after!.text).toContain('first,m1')
  }, 120_000)

  it('is not rechecked after a request no handler answers, under a base, a locale and a trailing slash', async () => {
    const root = await guestbook(under)
    const answers = await served(root, [noise('/_kay/analytics'), noise('/_kay/error'), noise('/en/nowhere/'), noise('/en/_kay/analytics'), read('/about/'), read('/en/about/'), read('/calls.json')])

    expect((JSON.parse(answers.at(-1)!.text) as Tally).stable).toBe(0)
  }, 120_000)

  it('is checked per locale, under a base and a trailing slash', async () => {
    const root = await guestbook(under)
    const [, fr, en, again] = await served(root, [post('add.kay', 'save'), read('/'), read('/en/'), read('/en/')])

    expect(fr!.text).toContain('Bonjour first,m1')
    expect(en!.text).toContain('Hello first,m1')
    expect(again!.text).toContain('Hello first,m1')
  }, 120_000)
})

describe('a kept page and the state a script declares', () => {
  const roots: string[] = []
  const route = (root: string, file: string) => ({ file: join(root, file), layouts: [] })

  async function scratch(files: Record<string, string>): Promise<string> {
    const root = await project(files)

    roots.push(root)

    return root
  }

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('keeps a page whose component script declares a let or an empty container per render', async () => {
    const root = await scratch({
      'src/routes/index.kay': '---\nlet title = \'Home\'\nconst items = []\nconst options = {}\nconst seen = new Map<string, number>()\n---\nh1 {title}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/index.kay'))).toBe(true)
  })

  it('keeps a page whose server fence declares a let or an empty container per request', async () => {
    const root = await scratch({
      'src/routes/index.kay': '--- server\nlet title = \'Home\'\nconst items: string[] = []\nconst options = {}\n---\nh1 {title}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/index.kay'))).toBe(true)
  })

  it('keeps a page importing a component whose script declares them', async () => {
    const root = await scratch({
      'src/routes/index.kay': '---\nimport Card from \'../card.kay\'\n---\nCard\n',
      'src/card.kay': '---\nlet label = \'Card\'\nconst parts = []\n---\np {label}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/index.kay'))).toBe(true)
  })

  it('keeps refusing a page whose server fence shares a let or an empty container with an export', async () => {
    const root = await scratch({
      'src/routes/let.kay': '--- server\nlet count = 0\n\nexport const bump = action(s.Object({}), async () => {\n  count++\n})\n---\np {count}\n',
      'src/routes/list.kay': '--- server\nconst seen = []\n\nexport const add = action(s.Object({}), async () => {\n  seen.push(1)\n})\n---\np {seen.length}\n',
      'src/routes/exported.kay': '--- server\nexport const seen: string[] = []\n---\np {seen.length}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/let.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/list.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/exported.kay'))).toBe(false)
  })

  it('tells a page setting from another export in a server fence', async () => {
    const root = await scratch({
      'src/routes/settings.kay': '--- server\nlet title = \'Home\'\n\nexport const page = { prerender: true, revalidate: \'1h\' }\n---\nh1 {title}\n',
      'src/routes/typed.kay': '--- server\nlet title = \'Home\'\n\nexport type Row = { id: number }\n---\nh1 {title}\n',
      'src/routes/named.kay': '--- server\nconst seen = []\n\nexport const pageSize = seen.length\n---\np {pageSize}\n',
      'src/routes/function.kay': '--- server\nlet count = 0\n\nexport async function bump(): Promise<void> {\n  count++\n}\n---\np {count}\n',
      'src/routes/class.kay': '--- server\nlet count = 0\n\nexport abstract class Counter {\n  bump(): void {\n    count++\n  }\n}\n---\np {count}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/settings.kay'))).toBe(true)
    expect(await readsNothing(route(root, 'src/routes/typed.kay'))).toBe(true)
    expect(await readsNothing(route(root, 'src/routes/named.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/function.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/class.kay'))).toBe(false)
  })

  it('keeps a page whose lastmod reads the clock, as the sitemap reads it and no render does', async () => {
    const root = await scratch({
      'src/routes/dated.kay': '--- server\nexport const page = { sitemap: true, lastmod: new Date(\'2026-03-04T10:00:00Z\') }\n---\nh1 Dated\n',
      'src/routes/computed.kay': '--- server\nexport const page = {\n  lastmod: () => new Date(Date.now() - 1000),\n}\n---\nh1 Computed\n',
      'src/routes/reading.kay': '--- server\nexport const page = { lastmod: new Date(\'2026-03-04\') }\nconst now = new Date()\n---\nh1 {now.getFullYear()}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/dated.kay'))).toBe(true)
    expect(await readsNothing(route(root, 'src/routes/computed.kay'))).toBe(true)
    // What the page reads outside `lastmod` still counts.
    expect(await readsNothing(route(root, 'src/routes/reading.kay'))).toBe(false)
  })

  it('keeps a layout whose script declares a let per render', async () => {
    const root = await scratch({
      'src/routes/_layout.kay': '---\nlet label = \'Site\'\n---\np {label}\nslot\n',
      'src/routes/index.kay': 'h1 Home\n',
    })

    expect(await readsNothing({ file: join(root, 'src/routes/index.kay'), layouts: [join(root, 'src/routes/_layout.kay')] })).toBe(true)
  })

  it('keeps a page exporting an action when its let or empty container is not one the export reads', async () => {
    const root = await scratch({
      'src/routes/script.kay': '--- server\nexport const save = action(s.Object({}), async () => {})\n---\n---\nlet label = \'Save\'\nconst parts = []\n---\nform(action={save}) button {label}\n',
      'src/routes/fence.kay': '--- server\nlet title = \'Home\'\nconst items: string[] = []\n\nexport const save = action(s.Object({}), async () => {})\n---\nh1 {title}\nform(action={save}) button Save\n',
    })

    expect(await readsNothing(route(root, 'src/routes/script.kay'))).toBe(true)
    expect(await readsNothing(route(root, 'src/routes/fence.kay'))).toBe(true)
  })

  it('refuses a page whose export reads a fence let through a helper, or that exports a let itself', async () => {
    const root = await scratch({
      'src/routes/chain.kay': '--- server\nlet n = 0\nconst inc = () => n++\n\nexport const save = action(s.Object({}), async () => {\n  inc()\n})\n---\np {n}\n',
      'src/routes/commented.kay': '--- server\n/* count */ let count = 0\n\nexport const save = action(s.Object({}), async () => {\n  count++\n})\n---\np {count}\n',
      'src/routes/exported.kay': '--- server\nexport let n = 0\n---\np {n}\n',
      'src/routes/typing.kay': '--- server\nlet count = 0\nexport const save = action(s.Object({}), async () => {\n---\np Typing\n',
    })

    for (const file of ['chain', 'commented', 'exported', 'typing'])
      expect(await readsNothing(route(root, `src/routes/${file}.kay`)), file).toBe(false)
  })

  it('sees an empty container declared later in a list, and not a local let at the start of a line in a function', async () => {
    const root = await scratch({
      'src/routes/listed.kay': '---\nimport { count } from \'../listed\'\n---\np {count()}\n',
      'src/routes/wrapped.kay': '---\nimport { count } from \'../wrapped\'\n---\np {count()}\n',
      'src/routes/fence.kay': '--- server\nconst a = 1, seen: number[] = []\n\nexport const save = action(s.Object({}), async () => {\n  seen.push(a)\n})\n---\np {seen.length}\n',
      'src/routes/local.kay': '--- server\nexport function total(values: number[]): number {\nlet sum = 0\n\nfor (const value of values)\n  sum += value\n\nreturn sum\n}\n---\np {total([1, 2])}\n',
      'src/listed.ts': 'const base = 1, seen: number[] = []\n\nexport function count(): number {\n  return seen.push(base)\n}\n',
      'src/wrapped.ts': 'const base = 1,\n  seen = new Map<string, number>()\n\nexport function count(): number {\n  return seen.set(String(base), 1).size\n}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/listed.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/wrapped.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/fence.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/local.kay'))).toBe(true)
  })

  it('tells a declarator holding an empty container from a default value, a parameter or a string', async () => {
    // Each module is imported by a page of the same name; true is a module the page may be kept with.
    const modules: Record<string, [string, boolean]> = {
      'list-two': ['const a = 1, seen = []\n', false],
      'list-three': ['const a = 1,\n  b = 2,\n  seen = []\n', false],
      'list-object-before': ['const a = {\n  x: 1,\n}, seen = []\n', false],
      'list-comment': ['const a = 1, // note\n  seen = []\n', false],
      'list-typed-comma': ['const a = 1, seen: Map<string, number> = new Map()\n', false],
      'first-typed-comma': ['const seen: Map<string, number> = new Map()\n', false],
      'first-generic-new': ['const seen = new Map<string, number>()\nconst other = 1\n', false],
      'nested-generic': ['const a = new Map<string, Set<number>>(), seen = {}\n', false],
      'cast': ['const seen = [] as string[]\n', false],
      'trailing-comment': ['const seen = {} // filled later\n', false],
      'after-statement': ['const a = 1\nconst seen = new Set<string>()\n', false],
      'exported': ['export const a = 1, seen = new Map()\n', false],
      'let': ['let count = 0\n', false],
      'stray-closer': ['}\nconst seen = []\n', false],
      'regex-quote': ['const re = /[\'"]/g\nconst seen = []\n', false],
      'regex-slashes': ['export const re = /https?:\\/\\//\nconst seen = []\n', false],
      'division': ['const a = 4 / 2, b = 1 / 2\nconst seen = []\n', false],
      'default-param': ['export const f = (a: number, b: number[] = []) => a\n', true],
      'default-destructure': ['const opts = { a: 1 }\nexport const { a, b = {} } = opts\n', true],
      'quoted': ['export const s = \'x, y = []\'\n', true],
      'template': ['export const s = `x, y = ${1 + 1} [] `\n', true],
      'comment-only': ['// const seen = []\n/* let count = 0 */\nexport const a = 1\n', true],
      'local-let': ['export function f(): number {\nlet sum = 0\n\nreturn sum\n}\n', true],
      'filled': ['const a = [1], b = { x: 1 }, c = new Map([[1, 2]]).size\n\nexport const n = a.length + c\n', true],
      'call-result': ['const a = [].concat([1]), b = 2\n\nexport const n = a.length + b\n', true],
      'many-lines': ['export const a = 1,\n  b = 2,\n  c = 3\n', true],
    }
    const files: Record<string, string> = {}

    for (const [name, [source]] of Object.entries(modules)) {
      files[`src/${name}.ts`] = source
      files[`src/routes/${name}.kay`] = `---\nimport '../${name}'\n---\np ${name}\n`
    }

    const root = await scratch(files)

    for (const [name, [, kept]] of Object.entries(modules))
      expect(await readsNothing(route(root, `src/routes/${name}.kay`)), name).toBe(kept)
  })

  it('tells them apart in a server fence too', async () => {
    const root = await scratch({
      'src/routes/list.kay': '--- server\nconst a = 1,\n  b = 2,\n  seen: Map<string, number> = new Map()\n\nexport const save = action(s.Object({}), async () => {\n  seen.set(\'a\', a + b)\n})\n---\np {seen.size}\n',
      'src/routes/default.kay': '--- server\nconst f = (a: number, b: number[] = []) => a\n\nexport const save = action(s.Object({}), async () => {\n  f(1)\n})\n---\np {f(2)}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/list.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/default.kay'))).toBe(true)
  })

  it('keeps refusing a page importing a .ts module with a module-level let or empty container', async () => {
    const root = await scratch({
      'src/routes/let.kay': '---\nimport { next } from \'../counted\'\n---\np {next()}\n',
      'src/routes/array.kay': '---\nimport { push } from \'../listed\'\n---\np {push()}\n',
      'src/routes/object.kay': '---\nimport { put } from \'../mapped\'\n---\np {put()}\n',
      'src/counted.ts': 'let count = 0\n\nexport function next(): number {\n  return ++count\n}\n',
      'src/listed.ts': 'const seen: number[] = []\n\nexport function push(): number {\n  return seen.push(1)\n}\n',
      'src/mapped.ts': 'const seen = {}\n\nexport function put(): number {\n  return Object.keys(seen).length\n}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/let.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/array.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/object.kay'))).toBe(false)
  })

  it('keeps refusing a page that reads Math.random through a destructuring or an alias', async () => {
    const root = await scratch({
      'src/routes/direct.kay': 'p {Math.random()}\n',
      'src/routes/destructured.kay': '---\nconst { random } = Math\n---\np {random()}\n',
      'src/routes/aliased.kay': '---\nconst m = Math\n---\np {m.random()}\n',
      'src/routes/computed.kay': 'p {Math[\'random\']()}\n',
      'src/routes/floor.kay': 'p {Math.floor(1.5)}\n',
    })

    expect(await readsNothing(route(root, 'src/routes/direct.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/destructured.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/aliased.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/computed.kay'))).toBe(false)
    expect(await readsNothing(route(root, 'src/routes/floor.kay'))).toBe(true)
  })

  it('builds the page with the per-render script kept, and serves it', async () => {
    const root = await scratch({
      'src/routes/index.kay': '---\nlet title = \'Home\'\nconst items = []\n---\nh1 {title}\n',
    })

    expect(await built(root)).toEqual(['/'])

    const [home] = await served(root, [{ path: '/' }])

    expect(home!.etag).not.toBeNull()
    expect(home!.text).toContain('Home')
  }, 60_000)

  it('gives a path to the page that was asked for, over a kept one, whichever is met first', async () => {
    const asked = '--- server\nconst slug = ctx.params.slug\n\nexport const page = { prerender: [{ slug: \'index\' }] }\n---\np Asked {slug}\n'
    const first = await scratch({ 'src/routes/index.kay': 'p Kept home\n', 'src/routes/[slug].kay': asked })
    const second = await scratch({ 'src/routes/index.kay': 'p Kept home\n', 'src/routes/index/index.kay': '--- server\nexport const page = { prerender: true }\n---\np Asked index\n' })

    for (const root of [first, second]) {
      expect(await built(root)).toEqual(['/index'])

      const [index, home] = await served(root, [{ path: '/index' }, { path: '/' }])

      expect(index!.text).toContain('Asked index')
      expect(index!.etag).not.toBeNull()
      expect(home!.text).toContain('Kept home')
      expect(home!.etag).toBeNull()
    }
  }, 120_000)

  it('marks a prerendered page behind a guard for the analytics tracker, though it is rendered without its guards', async () => {
    const root = await scratch({
      'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\np Open\n',
      'src/routes/account/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n',
      'src/routes/account/index.kay': '--- server\nexport const page = { prerender: true }\n---\np Account\n',
    })

    await built(root)

    const pagesDir = join(outputDir(root), 'pages')

    expect(await Bun.file(join(pagesDir, 'account.html')).text()).toContain('<meta name="kay-guarded">')
    expect(await Bun.file(join(pagesDir, 'index.html')).text()).not.toContain('kay-guarded')
  }, 120_000)

  it('leaves no file for a kept page that gave way or drifted, and keeps it out of the pages it lists', async () => {
    const root = await scratch({
      'src/routes/index.kay': 'p Kept home\n',
      'src/routes/about.kay': 'p About\n',
      'src/routes/[slug].kay': '--- server\nconst slug = ctx.params.slug\n\nexport const page = { prerender: [{ slug: \'index\' }] }\n---\np Asked {slug}\n',
      'src/routes/drifting.kay': '---\nimport { drift } from \'../drift\'\n---\np {drift()}\n',
      'src/drift.ts': 'const state = { n: 0 }\n\nexport function drift(): number {\n  return state.n++\n}\n',
    })

    expect(await built(root)).toEqual(['/about', '/index'])

    const files = await Array.fromAsync(new Bun.Glob('**/*.html').scan({ cwd: join(outputDir(root), 'pages') }))

    expect(files.sort()).toEqual(['about.html', 'index.html'])
    expect(await Bun.file(join(outputDir(root), 'pages', 'index.html')).text()).toContain('Asked index')
  }, 120_000)
})

describe('what stops a page from being kept', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('names the file, line and reason of each thing that stops it', async () => {
    const root = await project({
      'src/routes/clock.kay': '--- server\nconst now = Date.now()\n---\np {now}\n',
      'src/routes/package.kay': '---\n\nimport { format } from \'dayjs\'\n---\np Hi\n',
      'src/routes/state.kay': '--- server\nconst seen = []\n\nexport const add = action(s.Object({}), async () => {\n  seen.push(1)\n})\n---\np {seen.length}\n',
      'src/routes/early.kay': '--- server\nexport const page = { keep: true }\n\nlet title = \'x\'\nexport const seen: string[] = []\n---\np {title}\n',
      'src/routes/imports.kay': '---\nimport \'../data.db\'\nimport { format } from \'dayjs\'\n---\np Hi\n',
      'src/data.db': '',
      'src/routes/fine.kay': 'p Fine\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    expect(await at('src/routes/clock.kay')).toEqual({ file: join(root, 'src/routes/clock.kay'), line: 2, why: 'reads `Date`' })
    expect(await at('src/routes/package.kay')).toEqual({ file: join(root, 'src/routes/package.kay'), line: 3, why: 'imports the package `dayjs`' })
    expect(await at('src/routes/state.kay')).toMatchObject({ line: 2, why: expect.stringContaining('module state') })
    expect(await at('src/routes/early.kay')).toMatchObject({ line: 5 })
    expect(await at('src/routes/imports.kay')).toMatchObject({ line: 2, why: 'imports `../data.db`, which is neither code nor a data file' })
    expect(await at('src/routes/fine.kay')).toBeUndefined()
  })

  it('keeps a page importing an ~icons icon, from the page, a component, a layout or a module, and stops at what only looks like one', async () => {
    const icon = '~icons/tabler/arrow-left'

    const root = await project({
      'package.json': PACKAGE_WITH_TABLER,
      'src/routes/direct.kay': `---\nimport ArrowLeft from '${icon}'\n---\nArrowLeft\n`,
      'src/routes/reexport.kay': '---\nimport { arrow } from \'../arrow\'\n---\narrow\n',
      'src/arrow.ts': `export { default as arrow } from '${icon}'\n`,
      'src/routes/through-component.kay': '---\nimport Back from \'../back.kay\'\n---\nBack\n',
      'src/back.kay': `---\nimport ArrowLeft from '${icon}'\n---\nArrowLeft\n`,
      'src/routes/layout/_layout.kay': `---\nimport ArrowLeft from '${icon}'\n---\nArrowLeft\nslot\n`,
      'src/routes/layout/index.kay': 'p Page\n',
      'src/routes/impure-beside.kay': `---\nimport ArrowLeft from '${icon}'\nimport { format } from 'dayjs'\n---\nArrowLeft\n`,
      'src/routes/impure-in-component.kay': '---\nimport Back from \'../impure-back.kay\'\n---\nBack\n',
      'src/impure-back.kay': `---\nimport ArrowLeft from '${icon}'\n---\np {new Date().toISOString()}\n`,
      'src/routes/deep.kay': '---\nimport Arrow from \'~icons/tabler/arrow/left\'\n---\nArrow\n',
      'src/routes/set-only.kay': '---\nimport Arrow from \'~icons/tabler\'\n---\nArrow\n',
      'src/routes/upper.kay': '---\nimport Arrow from \'~icons/Tabler/arrow-left\'\n---\nArrow\n',
      'src/routes/query.kay': `---\nimport Arrow from '${icon}?raw'\n---\nArrow\n`,
      'src/routes/extension.kay': `---\nimport Arrow from '${icon}.ts'\n---\nArrow\n`,
      'src/routes/prefix.kay': '---\nimport Arrow from \'~iconsx/tabler/arrow-left\'\n---\nArrow\n',
      'src/routes/alike.kay': '---\nimport Arrow from \'icons/tabler/arrow-left\'\n---\nArrow\n',
      'src/routes/uninstalled.kay': '---\nimport Mine from \'~icons/mine/thing\'\n---\nMine\n',
      'src/routes/missing.kay': '---\nimport Missing from \'~icons/tabler/no-such-icon\'\n---\nMissing\n',
    })

    roots.push(root)

    const route = (file: string, ...layouts: string[]) => ({ file: join(root, file), layouts: layouts.map(layout => join(root, layout)) })
    const keptStop = async (route: Route) => (await keptScan(route, undefined, root)).stop

    expect(await keptStop(route('src/routes/direct.kay'))).toBeUndefined()
    expect(await keptStop(route('src/routes/reexport.kay'))).toBeUndefined()
    expect(await keptStop(route('src/routes/through-component.kay'))).toBeUndefined()
    expect(await keptStop(route('src/routes/layout/index.kay', 'src/routes/layout/_layout.kay'))).toBeUndefined()
    expect(await keptStop(route('src/routes/impure-beside.kay'))).toMatchObject({ line: 3, why: 'imports the package `dayjs`' })
    expect(await keptStop(route('src/routes/impure-in-component.kay'))).toMatchObject({ file: join(root, 'src/impure-back.kay'), why: 'reads `Date`' })

    // A set the project does not install, or an icon it lacks, is left to the app's own resolution, which a tsconfig alias may send to code.
    for (const [file, specifier] of [['uninstalled', '~icons/mine/thing'], ['missing', '~icons/tabler/no-such-icon'], ['deep', '~icons/tabler/arrow/left'], ['set-only', '~icons/tabler'], ['upper', '~icons/Tabler/arrow-left'], ['query', `${icon}?raw`], ['extension', `${icon}.ts`], ['prefix', '~iconsx/tabler/arrow-left'], ['alike', 'icons/tabler/arrow-left']] as const)
      expect(await keptStop(route(`src/routes/${file}.kay`))).toMatchObject({ line: 2, why: `imports the package \`${specifier}\`` })
  })

  it('prerenders a page importing an installed icon, and renders the icon in it', async () => {
    const root = await project({
      'package.json': PACKAGE_WITH_TABLER,
      'src/routes/index.kay': '---\nimport ArrowLeft from \'~icons/tabler/arrow-left\'\n---\nArrowLeft(aria-hidden="true")\n',
      'src/routes/aliased.kay': '---\nimport Mine from \'~icons/mine/thing\'\n---\nMine\n',
    })

    roots.push(root)

    expect(await built(root)).toEqual(['/'])
    expect(await Bun.file(join(outputDir(root), 'pages', 'index.html')).text()).toContain('<svg')
  }, 120_000)

  it('shows each route kept or on request in the build report, with what stopped it', async () => {
    const root = await project({
      'src/routes/index.kay': 'p Home\n',
      'src/routes/clock.kay': '--- server\nconst now = Date.now()\n---\np {now}\n',
      'src/routes/random.kay': '--- server\nexport const page = { keep: true }\n---\np {Math.random()}\n',
      'src/routes/[id].kay': '--- server\nexport const page = { keep: true }\n---\np Item\n',
      'src/routes/other/[id].kay': 'p Other\n',
    })

    roots.push(root)

    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--format', 'json'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const document = JSON.parse(out) as { built: { routes: { route: string, kept: number, pages: number, stop?: string }[] }, problems: { code: string, message: string, line: number }[] }
    const routes = Object.fromEntries(document.built.routes.map(route => [route.route, route]))

    expect(routes['/']).toMatchObject({ kept: 1, pages: 0 })
    expect(routes['/']!.stop).toBeUndefined()
    expect(routes['/clock']).toMatchObject({ kept: 0 })
    // A route taking params and listing none was not looked at, unless it said it is to be kept.
    expect(routes['/other/:id']!.stop).toBeUndefined()
    expect(routes['/:id']!.stop).toContain('takes params')

    const unkept = document.problems.filter(problem => problem.code === 'unkept-page')

    expect(unkept.map(problem => problem.line).sort()).toEqual([1, 4])
    expect(unkept.map(problem => problem.message).join('\n')).toContain('`/random`')
    expect(routes['/clock']!.stop).toMatch(/^src\/routes\/clock\.kay:2 reads `Date`$/)
  }, 120_000)

  // The build's report, as `kay build --format json` gives it.
  async function reported(root: string, args: string[] = []) {
    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--format', 'json', ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { code, err, document: JSON.parse(out) as { built: { routes: { route: string, kept: number, stop?: string }[] }, problems: { code: string, message: string, line: number, severity?: string }[] } }
  }

  it('names what stops a page found while it renders: a stale copy and a path two pages share', async () => {
    const root = await project({
      'src/routes/revalidated.kay': '--- server\nexport const page = { revalidate: \'1h\' }\n---\np Revalidated\n',
      'src/routes/a.kay': 'p A\n',
      'src/routes/[id].kay': '--- server\nexport const page = { prerender: [{ id: \'a\' }] }\n---\np Item\n',
    })

    roots.push(root)

    const { document } = await reported(root)
    const stops = Object.fromEntries(document.built.routes.map(route => [route.route, route.stop]))

    expect(stops['/revalidated']).toBe('src/routes/revalidated.kay sets `revalidate`, which has a stale copy render again for every visitor')
    expect(stops['/a']).toBe('src/routes/a.kay would share its prerendered file a.html with /a')
  }, 120_000)

  it('names the rest of what stops a page found while it renders: a status, renders that differ and a server island', async () => {
    const root = await project({
      'src/routes/missing.kay': '--- server\nthrow new Error(\'broken\')\n---\np Missing\n',
      'src/routes/counter.kay': '--- server\nimport { next } from \'../next\'\n---\np {next()}\n',
      'src/next.ts': 'const box = { n: 0 }\n\nexport const next = () => ++box.n\n',
      'src/routes/under/_layout.kay': '---\nimport Aside from \'../../components/aside.kay\'\n---\nAside(server)\nslot\n',
      'src/routes/under/index.kay': 'p Under\n',
      'src/components/aside.kay': 'aside Aside\n',
    })

    roots.push(root)

    const { document } = await reported(root)
    const stops = Object.fromEntries(document.built.routes.map(route => [route.route, route.stop]))

    expect(stops['/missing']).toBe('src/routes/missing.kay answers 500 when rendered without a request')
    expect(stops['/counter']).toBe('src/routes/counter.kay renders differently each time, as it draws on something its source does not show')
    expect(stops['/under']).toBe('src/routes/under/index.kay holds a server island')
  }, 120_000)

  it('reports a page saying keep: true that is not kept at the level unkept-page has, and under --static a page the export renders', async () => {
    const files = { 'src/routes/random.kay': '--- server\nexport const page = { keep: true }\n---\np {Math.random()}\n' }
    const config = (lints: string) => `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ log: false, lints: { 'unkept-page': '${lints}' } })\n`
    const levels = async (lints: string, args: string[] = []) => {
      const root = await project({ ...files, 'kay.config.ts': config(lints) })

      roots.push(root)

      return (await reported(root, args)).document.problems.filter(problem => problem.code === 'unkept-page').map(problem => problem.severity)
    }

    expect(await levels('deny')).toEqual(['error'])
    expect(await levels('warn')).toEqual(['warning'])
    expect(await levels('allow')).toEqual([])
    expect(await levels('deny', ['--static'])).toEqual([])
  }, 120_000)

  it('reports a page saying keep: true beside prerender: false as a contradiction, and refuses keep exported on its own', async () => {
    const root = await project({
      'src/routes/both.kay': '--- server\nexport const page = { prerender: false, keep: true }\n---\np Both\n',
    })

    roots.push(root)

    const { document } = await reported(root)

    expect(document.built.routes.find(route => route.route === '/both')?.stop).toBe('src/routes/both.kay `prerender: false` contradicts `keep: true`')
    expect(document.problems.filter(problem => problem.code === 'unkept-page').map(problem => problem.message)).toEqual([expect.stringContaining('`prerender: false` contradicts `keep: true`')])
    expect(compileKay('--- server\nexport const keep = true\n---\np x\n', 'a.kay').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`keep` is a setting of `page`, not an export of its own'])
  }, 120_000)

  it('shows the reason of a route stopped past the 25 rows of the route table', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => ({ route: `/r${String(index).padStart(2, '0')}`, pages: 0, kept: 0, islands: [] as string[], estimated: false, js: 0, css: 0, stop: index === 25 ? 'reads `Date`' : undefined }))

    expect(formatRouteTable(rows)).toContain('not kept: /r25: reads `Date`')
  })
})

describe('what kay exports to a page that is kept', () => {
  const roots: string[] = []

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  it('classes every export of kay once, so a new one is filed on purpose', async () => {
    const exported = Object.keys(await import('../src/runtime')).sort()

    expect(Object.keys(KAY_EXPORTS).sort()).toEqual(exported)
  })

  it('keeps a page importing the schema builder, in a page, a module, a config and through a barrel', async () => {
    const root = await project({
      'src/routes/in-page.kay': '--- server\nimport { s } from \'kay\'\n\nconst shape = s.Object({ id: s.Number() })\n---\np {typeof shape}\n',
      'src/routes/in-module.kay': '---\nimport { shape } from \'../shape\'\n---\np {typeof shape}\n',
      'src/routes/through-barrel.kay': '---\nimport { shape } from \'../barrel\'\n---\np {typeof shape}\n',
      'src/routes/with-config.kay': '---\nimport { post } from \'../content.config\'\n---\np {typeof post}\n',
      'src/shape.ts': 'import { s } from \'kay\'\n\nexport const shape = s.Object({ id: s.Number() })\n',
      'src/barrel.ts': 'export * from \'./shape\'\n',
      'src/content.config.ts': 'import { s } from \'kay\'\n\nexport const post = s.Object({ title: s.String() })\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    for (const page of ['in-page', 'in-module', 'through-barrel', 'with-config'])
      expect(await at(`src/routes/${page}.kay`)).toBeUndefined()
  })

  it('keeps a page reading a persisted signal kept in localStorage, and not one kept in a cookie or the query', async () => {
    const root = await project({
      'src/routes/local.kay': '---\nimport { persisted } from \'kay\'\n\nconst theme = persisted(\'theme\', \'light\', { storage: \'local\' })\n---\np {theme()}\n',
      'src/routes/typed.kay': '---\nimport { persisted as keep } from \'kay\'\n\nconst open = keep<boolean>(\'open\', false, { storage: \'local\' })\n---\np {open()}\n',
      'src/routes/in-module.kay': '---\nimport { theme } from \'../theme\'\n---\np {theme()}\n',
      'src/routes/cookie.kay': '---\nimport { persisted } from \'kay\'\n\nconst theme = persisted(\'theme\', \'light\')\n---\np {theme()}\n',
      'src/routes/query.kay': '---\nimport { persisted } from \'kay\'\n\nconst page = persisted(\'page\', \'1\', { storage: \'query\' })\n---\np {page()}\n',
      'src/routes/mixed.kay': '---\nimport { persisted } from \'kay\'\n\nconst a = persisted(\'a\', \'1\', { storage: \'local\' })\nconst b = persisted(\'b\', \'1\')\n---\np {a()}{b()}\n',
      'src/routes/passed.kay': '---\nimport { persisted } from \'kay\'\n\nconst make = persisted\nconst a = make(\'a\', \'1\', { storage: \'local\' })\n---\np {a()}\n',
      'src/routes/spread.kay': '---\nimport { persisted } from \'kay\'\n\nconst more = { storage: \'cookie\' as const }\nconst a = persisted(\'a\', \'1\', { storage: \'local\', ...more })\n---\np {a()}\n',
      'src/routes/in-value.kay': '---\nimport { persisted } from \'kay\'\n\nconst a = persisted(\'a\', { storage: \'local\' })\n---\np {a()}\n',
      'src/routes/commented.kay': '---\nimport { persisted } from \'kay\'\n\nconst a = persisted(\'a\', \'1\', /* { storage: \'local\' } */)\n---\np {a()}\n',
      'src/routes/parens.kay': '---\nimport { persisted } from \'kay\'\n\nconst a = persisted(\'(\', \'1\', { storage: \'cookie\' })\nconst b = \'storage: "local"\'\n---\np {a()}\n',
      'src/routes/computed.kay': '---\nimport { persisted } from \'kay\'\n\nconst a = persisted(\'a\', \'1\', { storage: \'local\', [\'storage\']: \'cookie\' })\n---\np {a()}\n',
      'src/routes/quoted.kay': '---\nimport { persisted } from \'kay\'\n\nconst a = persisted(\'a\', \'1\', { storage: \'local\', "storage": \'cookie\' })\n---\np {a()}\n',
      'src/routes/through-barrel.kay': '---\nimport { cookie } from \'../barrel\'\n---\np {cookie()}\n',
      'src/barrel.ts': 'export * from \'./cookie\'\n',
      'src/cookie.ts': 'import { persisted } from \'kay\'\n\nexport const cookie = persisted(\'c\', \'1\')\n',
      'src/theme.ts': 'import { persisted } from \'kay\'\n\nexport const theme = persisted(\'theme\', \'light\', { storage: \'local\' })\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    for (const page of ['local', 'typed', 'in-module'])
      expect(await at(`src/routes/${page}.kay`)).toBeUndefined()

    for (const page of ['cookie', 'query', 'mixed', 'passed', 'spread', 'in-value', 'commented', 'parens', 'computed', 'quoted'])
      expect(await at(`src/routes/${page}.kay`)).toMatchObject({ why: expect.stringMatching(/^imports `persisted(?: as keep)?` from `kay`, which a request or the clock can change$/) })

    expect(await at('src/routes/through-barrel.kay')).toMatchObject({ file: join(root, 'src/cookie.ts') })
  })

  it('judges a value of kay a page reads with no import as it judges an imported one', async () => {
    const root = await project({
      'src/routes/free.kay': '---\nconst id = uid()\nconst count = signal(1)\n---\np {id} {count()}\n',
      'src/routes/local.kay': '---\nconst theme = persisted(\'theme\', \'light\', { storage: \'local\' })\n---\np {theme()}\n',
      'src/routes/cookie.kay': '---\nconst theme = persisted(\'theme\', \'light\')\n---\np {theme()}\n',
      'src/routes/server.kay': '--- server\nconst origin = publicEnv.SITE\n---\np {origin}\n',
      'src/routes/declared.kay': '---\nconst live = 1\n---\np {live}\n',
      'src/routes/template.kay': 'p {publicEnv.SITE}\n',
      'src/routes/markdown.kay': 'markdown\n  Hello {publicEnv.SITE}\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    expect(await at('src/routes/template.kay')).toMatchObject({ why: expect.stringContaining('`publicEnv`') })
    expect(await at('src/routes/markdown.kay')).toMatchObject({ why: expect.stringContaining('`publicEnv`') })

    expect(await at('src/routes/free.kay')).toBeUndefined()
    expect(await at('src/routes/local.kay')).toBeUndefined()
    expect(await at('src/routes/declared.kay')).toBeUndefined()
    expect(await at('src/routes/cookie.kay')).toMatchObject({ why: expect.stringContaining('`persisted`') })
    expect(await at('src/routes/server.kay')).toMatchObject({ why: expect.stringContaining('`publicEnv`') })
  })

  it('classes every export of kay/content once', async () => {
    expect(Object.keys(CONTENT_EXPORTS).sort()).toEqual(Object.keys(await import('../src/content')).sort())
  })

  it('keeps a page reading a collection over a folder, in a page, a module, a config and through a barrel, and not one over a loader', async () => {
    const root = await project({
      'src/routes/in-page.kay': '--- server\nimport { collection } from \'kay/content\'\nimport { s } from \'kay\'\n\nconst posts = collection(\'content/posts\', { schema: s.Object({ title: s.String() }) })\nconst all = await posts.all()\n---\np {all.length}\n',
      'src/routes/in-module.kay': '--- server\nimport { posts } from \'../posts\'\n\nconst all = await posts.all()\n---\np {all.length}\n',
      'src/routes/through-barrel.kay': '--- server\nimport { posts } from \'../barrel\'\n\nconst all = await posts.all()\n---\np {all.length}\n',
      'src/routes/with-config.kay': '--- server\nimport { posts } from \'../content.config\'\nimport { paginate } from \'kay/content\'\n\nconst all = await posts.all()\n---\np {all.length}{typeof paginate}\n',
      'src/routes/loader.kay': '--- server\nimport { rows } from \'../rows\'\n\nconst all = await rows.all()\n---\np {all.length}\n',
      'src/routes/loader-barrel.kay': '--- server\nimport { rows } from \'../rows-barrel\'\n\nconst all = await rows.all()\n---\np {all.length}\n',
      'src/routes/edits.kay': '---\nimport { collection, saveEntry } from \'kay/content\'\n---\np {typeof saveEntry}\n',
      'src/routes/unknown.kay': '---\nimport { somethingNew } from \'kay/content\'\n---\np Hi\n',
      'src/routes/whole.kay': '---\nimport * as content from \'kay/content\'\n---\np {typeof content}\n',
      'src/routes/aliased.kay': '---\nimport { collection as make } from \'kay/content\'\nimport { s } from \'kay\'\n\nconst posts = make(\'content/posts\', { schema: s.Object({ title: s.String() }) })\n---\np {typeof posts}\n',
      'src/routes/passed.kay': '---\nimport { collection } from \'kay/content\'\n\nconst make = collection\nconst posts = make(\'content/posts\', {})\n---\np {typeof posts}\n',
      'src/routes/commented.ts': 'import { collection } from \'kay/content\'\n\n// The collection of posts, which a loader may fill\nexport const posts = collection(/* the folder */ \'content/posts\', {}) // a collection\n',
      'src/routes/regex-slash.ts': 'import { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [] }\n\nexport const ok = /a\\//.test(\'a/\'), posts = collection(loader, {})\n',
      'src/routes/regex-quote.ts': 'import { collection } from \'kay/content\'\n\nexport const quote = /["\']/\n// the collection of posts\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/nested-template.ts': 'import { collection } from \'kay/content\'\n\nexport const label = `a ${ `it\'s` } b`\n// the collection of posts\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/nested-loader.ts': 'import { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [] }\n\nexport const label = `a ${ `b` } c`, posts = collection(loader, {})\n',
      'src/routes/division.ts': 'import { collection } from \'kay/content\'\n\nexport const half = (total: number) => total / 2 // a collection\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/division-after-brace.ts': 'import { collection } from \'kay/content\'\n\nexport const half = Math.max({ total: 4 } / 2, 0) // a collection\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/division-after-nested-object.ts': 'import { collection } from \'kay/content\'\n\nexport const half = Math.max({ a: {} } / 2, 0) // a collection\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/division-after-ternary-object.ts': 'import { collection } from \'kay/content\'\n\nexport const half = (flag: boolean) => flag ? {} / 2 : 1 // a collection\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/regex-after-case-block.ts': 'import { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [] }\n\nexport const f = (n: number) => { switch (n) { case 1: { } /a\\//.test(\'a/\') } }, posts = collection(loader, {})\n',
      'src/routes/regex-after-label-block.ts': 'import { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [] }\n\nexport const f = () => { outer: { } /a\\//.test(\'a/\') }, posts = collection(loader, {})\n',
      'src/routes/division-in-nested-value.ts': 'import { collection } from \'kay/content\'\n\nexport const half = Math.max({ a: {} / 2 }, 0) // a collection\nexport const posts = collection(\'content/posts\', {})\n',
      'src/routes/regex-after-quoted-case.ts': 'import { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [] }\n\nexport const f = (n: string) => { switch (n) { case \'a:b\': { } /a\\//.test(\'a/\') } }, posts = collection(loader, {})\n',
      'src/routes/regex-after-fallthrough-block.ts': 'import { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [] }\n\nexport const f = (n: number) => { switch (n) { case 1: case 2: { } /a\\//.test(\'a/\') } }, posts = collection(loader, {})\n',
      'src/routes/multiline.ts': 'import { collection } from \'kay/content\'\n\nexport const posts = collection(\n  \'content/posts\',\n  {},\n)\n',
      'src/routes/mixed.ts': 'import { collection } from \'kay/content\'\n\nexport const a = collection(\'content/a\', {})\nexport const b = collection({ name: \'b\', load: () => [] }, {})\n',
      'src/routes/interpolated.ts': 'import { collection } from \'kay/content\'\n\nconst lang = \'fr\'\n\nexport const posts = collection(`content/${lang}`, {})\n',
      'src/posts.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const posts = collection<{ title: string }>("content/posts", { schema: s.Object({ title: s.String() }) })\n',
      'src/barrel.ts': 'export * from \'./posts\'\n',
      'src/content.config.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const posts = collection(`content/posts`, { schema: s.Object({ title: s.String() }), sort: (a, b) => a.data.title.localeCompare(b.data.title) })\n',
      'src/rows.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nconst loader = { name: \'rows\', load: () => [{ slug: \'a\', data: { title: \'A\' } }] }\n\nexport const rows = collection(loader, { schema: s.Object({ title: s.String() }) })\n',
      'src/rows-barrel.ts': 'export { rows } from \'./rows\'\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    for (const page of ['in-page', 'in-module', 'through-barrel', 'with-config'])
      expect(await at(`src/routes/${page}.kay`)).toBeUndefined()

    const loader = { why: expect.stringMatching(/^calls `collection` with something other than a folder written as a string/) }

    for (const page of ['loader', 'loader-barrel'])
      expect(await at(`src/routes/${page}.kay`)).toMatchObject({ file: join(root, 'src/rows.ts'), ...loader })

    expect(await at('src/routes/passed.kay')).toMatchObject(loader)
    expect(await at('src/routes/commented.ts')).toBeUndefined()
    expect(await at('src/routes/multiline.ts')).toBeUndefined()

    for (const page of ['regex-quote', 'nested-template', 'division', 'division-after-brace', 'division-after-nested-object', 'division-after-ternary-object', 'division-in-nested-value'])
      expect(await at(`src/routes/${page}.ts`), page).toBeUndefined()

    for (const page of ['regex-slash', 'nested-loader', 'regex-after-case-block', 'regex-after-label-block', 'regex-after-quoted-case', 'regex-after-fallthrough-block'])
      expect(await at(`src/routes/${page}.ts`), page).toMatchObject(loader)

    expect(await at('src/routes/mixed.ts')).toMatchObject(loader)
    expect(await at('src/routes/interpolated.ts')).toMatchObject(loader)
    expect(await at('src/routes/aliased.kay')).toBeUndefined()
    expect(await at('src/routes/edits.kay')).toMatchObject({ why: 'imports `collection`, `saveEntry` from `kay/content`, which a request or the clock can change' })
    expect(await at('src/routes/unknown.kay')).toMatchObject({ why: 'imports `somethingNew` from `kay/content`, which a request or the clock can change' })
    expect(await at('src/routes/whole.kay')).toMatchObject({ why: 'imports the whole module from `kay/content`, which a request or the clock can change' })
  })

  it('keeps a page over a folder collection in a build, and not one over a loader or reading ctx', async () => {
    const root = await project({
      'src/routes/index.kay': '--- server\nimport { posts } from \'../content.config\'\n\nconst all = await posts.all()\n---\nul\n  for post of all\n    li {post.data.title}\n',
      'src/routes/loaded.kay': '--- server\nimport { rows } from \'../rows\'\n\nconst all = await rows.all()\n---\np {all.length}\n',
      'src/routes/about.kay': '--- server\nimport { posts } from \'../content.config\'\n\nconst all = await posts.all()\nconst path = ctx.url.search\n---\np {all.length}{path}\n',
      'src/content.config.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const posts = collection(\'content/posts\', { schema: s.Object({ title: s.String() }) })\n',
      'src/rows.ts': 'import { s } from \'kay\'\nimport { collection } from \'kay/content\'\n\nexport const rows = collection({ name: \'rows\', load: () => [{ slug: \'a\', data: { title: \'A\' } }] }, { schema: s.Object({ title: s.String() }) })\n',
      'src/content/posts/one.json': '{ "title": "One" }\n',
    })

    roots.push(root)

    expect(await built(root)).toEqual(['/'])
  }, 60_000)

  it('names what a page really reads beside an export that reads nothing', async () => {
    const root = await project({
      'src/routes/both.kay': '--- server\nimport { s } from \'kay\'\n\nconst shape = s.String()\n---\np {ctx.url.search}\n',
      'src/routes/bound.kay': '---\nimport { s, queryParam } from \'kay\'\n\nconst page = queryParam(\'page\')\n---\np {page()}\n',
      'src/routes/unknown.kay': '---\nimport { somethingNew } from \'kay\'\n---\np Hi\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    expect(await at('src/routes/both.kay')).toMatchObject({ why: 'reads `ctx`' })
    expect(await at('src/routes/bound.kay')).toMatchObject({ why: 'imports `queryParam` from `kay`, which a request or the clock can change' })
    expect(await at('src/routes/unknown.kay')).toMatchObject({ why: 'imports `somethingNew` from `kay`, which a request or the clock can change' })
  })

  it('keeps such pages in a build under a base', async () => {
    const root = await project({
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\' })\n',
      'src/routes/index.kay': '---\nimport { shape } from \'../shape\'\n---\np {typeof shape}\n',
      'src/routes/local.kay': '---\nimport { persisted } from \'kay\'\n\nconst theme = persisted(\'theme\', \'light\', { storage: \'local\' })\n---\np {theme()}\n',
      'src/routes/cookie.kay': '---\nimport { persisted } from \'kay\'\n\nconst theme = persisted(\'theme\', \'light\')\n---\np {theme()}\n',
      'src/shape.ts': 'import { s } from \'kay\'\n\nexport const shape = s.Object({ id: s.Number() })\n',
    })

    roots.push(root)

    expect(await built(root)).toEqual(['/', '/local'])
  }, 60_000)
})

describe('a page reading only what its path fixes', () => {
  const roots: string[] = []
  const AT_PATH = '--- server\nconst here = ctx.url.pathname\n---\np At {here}\n'

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  // One page per spelling, each a server fence reading `ctx` the way its name says.
  const KEPT_READS: Record<string, string> = {
    'direct': 'p {ctx.url.pathname}\n',
    'split': '--- server\nconst parts = ctx.url.pathname.split(\'/\').filter(Boolean)\n---\np {parts[0]}\n',
    'optional chain': '--- server\nconst path = ctx?.url?.pathname\n---\np {path}\n',
    'compared': '--- server\nconst home = ctx.url.pathname === \'/\'\n---\np {home}\n',
    'destructured': '--- server\nconst { url: { pathname } } = ctx\n---\np {pathname}\n',
    'aliased': '--- server\nconst { url: { pathname: here = \'/\' } } = ctx\n---\np {here}\n',
    'params': '--- server\nconst slug = ctx.params.slug\n---\np {slug}\n',
    'a newline before a statement that does not continue': '--- server\nconst { url: { pathname } } = ctx\nconst parts = pathname.split(\'/\')\n---\np {parts.length}\n',
    'params destructured': '--- server\nconst { params, url: { pathname } } = ctx\n---\np {pathname}{params.slug}\n',
  }
  const STOPPED_READS: Record<string, string> = {
    'search': 'p {ctx.url.search}\n',
    'search params': 'p {ctx.url.searchParams.get(\'q\')}\n',
    'indexed': 'p {ctx.url[\'search\']}\n',
    'url whole': '--- server\nconst url = ctx.url\n---\np {url.pathname}\n',
    'url destructured': '--- server\nconst { url } = ctx\n---\np {url.pathname}\n',
    'url search destructured': '--- server\nconst { url: { search } } = ctx\n---\np {search}\n',
    'url with a rest': '--- server\nconst { url: { pathname, ...rest } } = ctx\n---\np {pathname}\n',
    'rest of ctx': '--- server\nconst { params, ...rest } = ctx\n---\np {rest.request.url}\n',
    'request': 'p {ctx.request.url}\n',
    'cookies': 'p {ctx.cookies.get(\'a\')}\n',
    'headers': 'p {ctx.request.headers.get(\'a\')}\n',
    'locals': 'p {ctx.locals}\n',
    'query': 'p {ctx.query}\n',
    'passed on': '--- server\nimport { describe } from \'../../describe\'\n---\np {describe(ctx)}\n',
    'url passed on': '--- server\nimport { describe } from \'../../describe\'\n---\np {describe(ctx.url)}\n',
    'aliased ctx': '--- server\nconst here = ctx\n---\np {here.url.pathname}\n',
    'assigned': '--- server\nctx.url.pathname = \'/other\'\n---\np Hi\n',
    'incremented': '--- server\nctx.url.pathname += \'/more\'\n---\np Hi\n',
    'continued onto a property': '--- server\nconst { params } = ctx\n  .cookies\n---\np {params}\n',
    'continued onto url': '--- server\nconst { params } = ctx\n.url\n---\np {params}\n',
    'continued by a ternary': '--- server\nconst { params } = ctx\n? 1 : 2\n---\np {params}\n',
    'continued by an index': '--- server\nconst { params } = ctx\n[0]\n---\np {params}\n',
    'a pathname read after a search': '--- server\nconst here = ctx.url.pathname\nconst found = ctx.url.search\n---\np {here}{found}\n',
  }
  const fileOf = (name: string) => name.replaceAll(' ', '-')

  it('is told apart from a page reading anything else of ctx, in a page, a layout and a component', async () => {
    const root = await project({
      ...Object.fromEntries(Object.entries(KEPT_READS).map(([name, source]) => [`src/routes/${fileOf(name)}.kay`, source])),
      ...Object.fromEntries(Object.entries(STOPPED_READS).map(([name, source]) => [`src/routes/stopped/${fileOf(name)}.kay`, source])),
      'src/describe.ts': 'export function describe(value: unknown): string {\n  return String(value)\n}\n',
      'src/layout-reading/_layout.kay': '--- server\nconst current = ctx.url.pathname\n---\np {current}\nslot\n',
      'src/layout-reading/index.kay': 'p Page\n',
      'src/nav.kay': '--- server\nconst { url: { pathname } } = ctx\n---\nnav {pathname}\n',
      'src/nav-search.kay': '--- server\nconst found = ctx.url.search\n---\nnav {found}\n',
      'src/routes/with-nav.kay': '---\nimport Nav from \'../nav.kay\'\n---\nNav\n',
      'src/routes/with-nav-search.kay': '---\nimport Nav from \'../nav-search.kay\'\n---\nNav\n',
      'src/helper.ts': 'export function here(ctx: { url: URL }): string {\n  return ctx.url.pathname\n}\n',
      'src/routes/with-helper.kay': '--- server\nimport { here } from \'../helper\'\n---\np {here(ctx)}\n',
      'src/routes/foreign.kay': '--- server\nconst widget = { ctx: { url: 1 } }\nconst found = widget.ctx.url\n---\np {found}\n',
    })

    roots.push(root)

    const stopOf = async (file: string, ...layouts: string[]) => keptStop({ file: join(root, file), layouts: layouts.map(layout => join(root, layout)) })

    for (const name of Object.keys(KEPT_READS)) {
      const file = `src/routes/${fileOf(name)}.kay`

      expect(await stopOf(file), name).toBeUndefined()
      // A page that reads the pathname is kept only at the path it was rendered at, so the scan must say it does.
      expect((await keptScan({ file: join(root, file), layouts: [] })).pathname, name).toBe(!name.startsWith('params') || name === 'params destructured')
    }

    const reading = async (file: string, ...layouts: string[]) => (await keptScan({ file: join(root, file), layouts: layouts.map(layout => join(root, layout)) })).pathname

    for (const name of Object.keys(STOPPED_READS))
      expect(await stopOf(`src/routes/stopped/${fileOf(name)}.kay`), name).toMatchObject({ why: 'reads `ctx`' })

    expect(await stopOf('src/layout-reading/index.kay', 'src/layout-reading/_layout.kay')).toBeUndefined()
    expect(await stopOf('src/routes/with-nav.kay')).toBeUndefined()
    expect(await reading('src/layout-reading/index.kay', 'src/layout-reading/_layout.kay')).toBe(true)
    expect(await reading('src/routes/with-nav.kay')).toBe(true)
    expect(await reading('src/routes/params.kay')).toBe(false)
    expect(await stopOf('src/routes/with-nav-search.kay')).toMatchObject({ file: join(root, 'src/nav-search.kay'), why: 'reads `ctx`' })
    expect(await stopOf('src/routes/with-helper.kay')).toMatchObject({ why: 'reads `ctx`' })
    expect(await stopOf('src/routes/foreign.kay')).toMatchObject({ why: 'reads `ctx`' })
  })

  it('keeps every page of a site whose layout reads the pathname, and not the one reading more', async () => {
    const root = await project({
      'src/routes/_layout.kay': '--- server\nconst parts = ctx.url.pathname.split(\'/\').filter(Boolean)\n---\nheader {parts[0] ?? \'home\'}\nslot\n',
      'src/routes/index.kay': 'h1 Home\n',
      'src/routes/about.kay': 'h1 About\n',
      'src/routes/contact.kay': '--- server\nconst sent = ctx.url.searchParams.has(\'sent\')\n---\nh1 Contact {String(sent)}\n',
      'src/routes/[slug].kay': '--- server\nconst slug = ctx.params.slug\n---\nh1 {slug}\n',
    })

    roots.push(root)

    expect(await built(root)).toEqual(['/', '/about'])

    const [about, contact] = await served(root, [{ path: '/about' }, { path: '/contact?sent=1' }])

    expect(about!.etag).not.toBeNull()
    expect(about!.text).toContain('<header>about</header>')
    expect(contact!.etag).toBeNull()
    expect(contact!.text).toContain('Contact true')
  }, 60_000)

  it('is served at the path it was rendered at, whichever way trailingSlash spells it', async () => {
    const files = { 'src/routes/about.kay': AT_PATH, 'src/routes/index.kay': AT_PATH }

    for (const trailingSlash of ['never', 'always', 'ignore']) {
      const root = await project({ ...files, 'kay.config.ts': `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ log: false, trailingSlash: '${trailingSlash}' })\n` })

      roots.push(root)
      expect(await built(root), trailingSlash).toEqual(['/', '/about'])

      const [bare, slashed, home] = await served(root, [{ path: '/about' }, { path: '/about/' }, { path: '/' }])

      // A page is served at the spelling `trailingSlash` allows, kept when it is the one rendered, rendered per request when it is the other.
      if (trailingSlash === 'never') {
        expect(bare!.text).toContain('At /about<')
        expect(bare!.etag).not.toBeNull()
        expect(slashed!.status).toBe(308)
      }
      else if (trailingSlash === 'always') {
        expect(bare!.status).toBe(308)
        expect(slashed!.text).toContain('At /about/<')
        expect(slashed!.etag).not.toBeNull()
      }
      else {
        expect(bare!.text).toContain('At /about<')
        expect(bare!.etag).not.toBeNull()
        expect(slashed!.text).toContain('At /about/<')
        expect(slashed!.etag).toBeNull()
      }

      expect(home!.text).toContain('At /<')
    }
  }, 120_000)

  it('serves a layout reading the pathname at the rendered spelling alone, and stores the path it was rendered at', async () => {
    const root = await project({
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, trailingSlash: \'ignore\' })\n',
      'src/routes/_layout.kay': '--- server\nconst { url: { pathname } } = ctx\n---\nheader {pathname}\nslot\n',
      'src/routes/about.kay': 'p About\n',
      'src/routes/plain.kay': 'p Plain\n',
    })

    roots.push(root)
    expect(await built(root)).toEqual(['/about', '/plain'])

    const manifest = await Bun.file(join(outputDir(root), 'manifest.json')).json() as { pages: Record<string, { pathname?: string }> }

    expect(manifest.pages['/about']!.pathname).toBe('/about')
    expect(manifest.pages['/plain']!.pathname).toBe('/plain')

    const [bare, slashed, hostile] = await served(root, [{ path: '/about' }, { path: '/about/' }, { path: '/%61bout' }])

    expect(bare!.etag).not.toBeNull()
    expect(bare!.text).toContain('<header>/about</header>')
    expect(slashed!.etag).toBeNull()
    expect(slashed!.text).toContain('<header>/about/</header>')
    expect(hostile!.etag).toBeNull()
    expect([200, 404]).toContain(hostile!.status)

    if (hostile!.status === 200)
      expect(hostile!.text).not.toContain('<header>/about</header>')
  }, 60_000)

  it('keeps a page whose path needs percent-encoding, at the spelling a browser sends', async () => {
    const root = await project({ 'src/routes/café.kay': AT_PATH })

    roots.push(root)
    expect(await built(root)).toEqual(['/caf%C3%A9'])

    const [encoded, decoded] = await served(root, [{ path: '/caf%C3%A9' }, { path: '/café' }])

    expect(encoded!.etag).not.toBeNull()
    expect(encoded!.text).toContain('At /caf%C3%A9<')
    expect(decoded!.text).toContain('At /caf%C3%A9<')
  }, 60_000)

  it('is kept once per locale prefix and under a base, the pathname being the one the router sees', async () => {
    const root = await project({
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\', i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\', messages: \'src/messages\' } })\n',
      'src/messages/fr.ts': MESSAGES.fr,
      'src/messages/en.ts': MESSAGES.en,
      'src/routes/_layout.kay': '--- server\nimport { t } from \'kay/i18n\'\n\nconst here = ctx.url.pathname\n---\nheader {t(\'hello\')} {here}\nslot\n',
      'src/routes/about.kay': 'p About\n',
    })

    roots.push(root)
    expect((await built(root)).sort()).toEqual(['/about', '/en/about'])

    const [fr, en] = await served(root, [{ path: '/about' }, { path: '/en/about' }])

    expect(fr!.etag).not.toBeNull()
    expect(fr!.text).toContain('<header>Bonjour /about</header>')
    expect(en!.etag).not.toBeNull()
    expect(en!.text).toContain('<header>Hello /en/about</header>')
  }, 60_000)

  it('is also kept by a static build, rendered at the path the host answers it at', async () => {
    const root = await project({
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, trailingSlash: \'always\' })\n',
      'src/routes/about.kay': AT_PATH,
    })

    roots.push(root)

    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--static', '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(code, `${out}${err}`).toBe(0)
    expect(await Bun.file(join(outputDir(root), 'pages/about.html')).text()).toContain('At /about/<')
  }, 60_000)
})

describe('a layout reading ctx.locals', () => {
  const roots: string[] = []
  const LOCALS_LAYOUT = '--- server\nconst who = ctx.locals.who\n---\nheader {who}\nslot\n'
  const DERIVED = '.derive({ as: \'global\' }, () => ({ who: \'ann\' }))'
  const FILES = { 'src/routes/_layout.kay': LOCALS_LAYOUT, 'src/routes/index.kay': 'h1 Home\n', 'src/routes/about.kay': 'h1 About\n' }

  afterAll(async () => {
    await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
  })

  const fails = async (root: string, ...flags: string[]) => {
    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', ...flags], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { code, text: `${out}${err}` }
  }

  it('leaves a page kept without prerender rendered per request, and the build passes', async () => {
    const root = await project(FILES)

    roots.push(root)
    expect(await built(root)).toEqual([])

    const { answers: [home, about] } = await servedWith(root, [{ path: '/' }, { path: '/about' }], '', DERIVED)

    expect(home!.text).toContain('<header>ann</header>')
    expect(about!.text).toContain('<header>ann</header>')
    expect(about!.etag).toBeNull()
  }, 60_000)

  it('does the same through a nested layout, a component it reaches and a destructured read', async () => {
    const root = await project({
      'src/routes/_layout.kay': 'slot\n',
      'src/routes/deep/_layout.kay': '--- server\nconst { locals } = ctx\n---\nheader {locals.who}\nslot\n',
      'src/routes/deep/index.kay': 'h1 Deep\n',
      'src/routes/part/index.kay': '---\nimport Who from \'../../who.kay\'\n---\nWho\n',
      'src/who.kay': '--- server\nconst who = ctx.locals.who\n---\np {who}\n',
      'src/routes/plain.kay': 'h1 Plain\n',
    })

    roots.push(root)
    expect(await built(root)).toEqual(['/plain'])
  }, 60_000)

  it('leaves a page holding a server island rendered per request, and the build passes', async () => {
    const root = await project({
      ...FILES,
      'src/routes/index.kay': '---\nimport Card from \'../card.kay\'\n---\nh1 Home\nCard(server)\n',
      'src/card.kay': 'p Card\n',
    })

    roots.push(root)
    expect(await built(root)).toEqual([])

    const [home] = (await servedWith(root, [{ path: '/' }], '', DERIVED)).answers

    expect(home!.text).toContain('<header>ann</header>')
  }, 60_000)

  it('names the file and line that read ctx.locals when prerender asks for the page', async () => {
    const root = await project({ ...FILES, 'src/routes/index.kay': '--- server\nexport const page = { prerender: true }\n---\nh1 Home\n' })

    roots.push(root)

    const { code, text } = await fails(root)

    expect(code).not.toBe(0)
    expect(text).toContain('reads `ctx.locals` at src/routes/_layout.kay:2')
    expect(text).toContain('every page under that layout renders it')
  }, 60_000)

  it('reads the line of a layout in a route group, and lists the page as on request', async () => {
    const root = await project({
      'src/routes/(shop)/_layout.kay': LOCALS_LAYOUT,
      'src/routes/(shop)/index.kay': '---\nimport Card from \'../../card.kay\'\n---\nCard(server)\n',
      'src/card.kay': 'p Card\n',
    })

    roots.push(root)

    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--format', 'json'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    expect(code, err).toBe(0)
    expect(out).toContain('reads `ctx.locals` at src/routes/(shop)/_layout.kay:2')

    await Bun.write(join(root, 'src/routes/(shop)/index.kay'), '--- server\nexport const page = { prerender: true }\n---\nh1 Shop\n')

    const failed = await fails(root)

    expect(failed.text).toContain('reads `ctx.locals` at src/routes/(shop)/_layout.kay:2')
    expect(failed.text).toContain('every page under that layout renders it')
  }, 60_000)

  it('names the file and line in a static export, under a base', async () => {
    const root = await project({ ...FILES, 'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\' })\n' })

    roots.push(root)

    const { code, text } = await fails(root, '--static')

    expect(code).not.toBe(0)
    expect(text).toContain('reads `ctx.locals` at src/routes/_layout.kay:2')
    expect(text).toContain('a static export renders every page at build time')
  }, 60_000)

  it('is kept per request under a base too', async () => {
    const root = await project({ ...FILES, 'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\' })\n' })

    roots.push(root)
    expect(await built(root)).toEqual([])
  }, 60_000)
})
