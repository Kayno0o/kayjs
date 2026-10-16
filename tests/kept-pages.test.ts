import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { readsNothing } from '../src/server/pure-page'
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
  headers?: Record<string, string>
}

interface Answered {
  status: number
  etag: string | null
  cache: string | null
  text: string
}

// A server of its own on what the build wrote, which the requests go through in order: one process serves one project.
async function served(root: string, asked: Asked[], options = ''): Promise<Answered[]> {
  await Bun.write(join(root, 'serve.ts'), `import { Elysia } from 'elysia'\nimport { pages } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}\n\nconst app = new Elysia().use(await pages({ root: ${JSON.stringify(root)}, prebuilt: true, log: false, compress: false${options} }))\nconst answers = []\n\nfor (const { path, headers } of ${JSON.stringify(asked)}) {\n  const response = await app.handle(new Request(\`http://localhost\${path}\`, { headers }))\n\n  answers.push({ status: response.status, etag: response.headers.get('etag'), cache: response.headers.get('cache-control'), text: await response.text() })\n}\n\nconsole.log(JSON.stringify(answers))\nprocess.exit(0)\n`)

  const child = Bun.spawn([process.execPath, join(root, 'serve.ts')], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  if (code !== 0)
    throw new Error(`${out}${err}`)

  return JSON.parse(out.slice(out.lastIndexOf('\n[') + 1)) as Answered[]
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
