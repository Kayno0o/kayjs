import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { keptStop, readsNothing } from '../src/server/pure-page'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const CONFIG = 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false })\n'
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})
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
}

interface Answered {
  status: number
  etag: string | null
  cache: string | null
  text: string
}

// A server of its own on what the build wrote, which the requests go through in order, a group of them together: one process serves one project.
// The warnings it logged come with the answers.
async function servedWith(root: string, asked: (Asked | Asked[])[], options = ''): Promise<{ answers: Answered[], warnings: string }> {
  await Bun.write(join(root, 'serve.ts'), `import { Elysia } from 'elysia'\nimport { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}\n\nconst app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, log: false, compress: false${options} }))\nconst answers = []\nconst ask = async ({ path, method, headers, body }) => {\n  const response = await app.handle(new Request(\`http://localhost\${path}\`, { method, headers, body }))\n\n  return { status: response.status, etag: response.headers.get('etag'), cache: response.headers.get('cache-control'), text: await response.text() }\n}\n\nfor (const group of ${JSON.stringify(asked)}) {\n  if (Array.isArray(group))\n    answers.push(...await Promise.all(group.map(ask)))\n  else\n    answers.push(await ask(group))\n}\n\nconsole.log(JSON.stringify(answers))\nprocess.exit(0)\n`)

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
  'src/routes/ctx.kay': 'p {ctx.url.pathname}\n',
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
  'src/todos.ts': 'export const todos: string[] = [\'first\']\n',
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
    const root = await project({ ...KEPT, 'src/routes/_layout.kay': 'slot\n', 'src/routes/reading/_layout.kay': 'p {ctx.url.pathname}\nslot\n', 'src/routes/reading/index.kay': 'p Page\n' })

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
const read = (path: string, headers?: Record<string, string>): Asked => headers ? { path, headers } : { path }
// The value is built by a call, which the build cannot see an action change; `tally` counts the renders the server makes.
const GUESTBOOK: Record<string, string> = {
  'src/guestbook.ts': 'export const messages = seed()\nexport const counts = tally()\n\nfunction seed(): string[] {\n  return [\'first\']\n}\n\nfunction tally() {\n  return { stable: 0, asked: 0 }\n}\n\nexport function add(): void {\n  messages.push(`m${messages.length}`)\n}\n\nexport function stable(): string {\n  counts.stable++\n\n  return \'Stable\'\n}\n\nexport function asked(): string {\n  counts.asked++\n\n  return messages.join(\',\')\n}\n',
  'src/routes/index.kay': '---\nimport { messages } from \'../guestbook\'\n---\np {messages.join(\',\')}\n',
  'src/routes/about.kay': '---\nimport { stable } from \'../guestbook\'\n---\np {stable()}\n',
  'src/routes/asked.kay': '--- server\nimport { asked } from \'../guestbook\'\n\nexport const page = { prerender: true }\n---\np {asked()}\n',
  'src/routes/add.kay': '--- server\nimport { s } from \'kay\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  add()\n})\n---\nform(action={save}) button Add\n',
  'src/routes/invalidate.kay': '--- server\nimport { s } from \'kay\'\nimport { invalidatePage } from \'kay/server\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  add()\n  invalidatePage(\'/\')\n})\n---\nform(action={save}) button Invalidate\n',
  'src/routes/fail.kay': '--- server\nimport { s } from \'kay\'\nimport { add } from \'../guestbook\'\n\nexport const save = action(s.Object({}), async () => {\n  add()\n\n  throw new Error(\'boom\')\n})\n---\nform(action={save}) button Fail\n',
  'src/routes/calls.json.ts': 'import { counts } from \'../guestbook\'\n\nexport function GET(): Response {\n  return Response.json(counts)\n}\n',
  'src/routes/private/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (!request.headers.has(\'x-pass\'))\n    deny(403)\n})\n',
  'src/routes/private/index.kay': '---\nimport { messages } from \'../../guestbook\'\n---\np {messages.join(\',\')}\n',
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

  it('is checked per locale, under a base and a trailing slash', async () => {
    const root = await guestbook({
      ...GUESTBOOK,
      'kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ log: false, base: \'/app\', trailingSlash: \'always\', i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\', messages: \'src/messages\' } })\n',
      'src/messages/fr.ts': MESSAGES.fr,
      'src/messages/en.ts': MESSAGES.en,
      'src/routes/index.kay': '--- server\nimport { t } from \'kay/i18n\'\nimport { messages } from \'../guestbook\'\n---\np {t(\'hello\')} {messages.join(\',\')}\n',
    })
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
      'src/routes/fine.kay': 'p Fine\n',
    })

    roots.push(root)

    const at = async (file: string) => keptStop({ file: join(root, file), layouts: [] })

    expect(await at('src/routes/clock.kay')).toEqual({ file: join(root, 'src/routes/clock.kay'), line: 2, why: 'reads `Date`' })
    expect(await at('src/routes/package.kay')).toEqual({ file: join(root, 'src/routes/package.kay'), line: 3, why: 'imports the package `dayjs`' })
    expect((await at('src/routes/state.kay'))?.why).toContain('module state')
    expect(await at('src/routes/fine.kay')).toBeUndefined()
  })

  it('shows each route kept or on request in the build report, with what stopped it', async () => {
    const root = await project({
      'src/routes/index.kay': 'p Home\n',
      'src/routes/clock.kay': '--- server\nconst now = Date.now()\n---\np {now}\n',
      'src/routes/random.kay': '--- server\nexport const page = { keep: true }\n---\np {Math.random()}\n',
    })

    roots.push(root)

    const child = Bun.spawn([process.execPath, CLI, 'build', root, '--format', 'json'], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
    const [out] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    const document = JSON.parse(out) as { built: { routes: { route: string, kept: number, pages: number, stop?: string }[] }, problems: { code: string, message: string, line: number }[] }
    const routes = Object.fromEntries(document.built.routes.map(route => [route.route, route]))

    expect(routes['/']).toMatchObject({ kept: 1, pages: 0 })
    expect(routes['/']!.stop).toBeUndefined()
    expect(routes['/clock']).toMatchObject({ kept: 0 })
    expect(routes['/clock']!.stop).toMatch(/clock\.kay:2 reads `Date`$/)
    expect(document.problems.filter(problem => problem.code === 'unkept-page').map(problem => problem.line)).toEqual([4])
  }, 120_000)
})
