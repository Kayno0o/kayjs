import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parse } from 'devalue'

const CLI = resolve('src/cli.ts')

const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] })

const LOGIN = `--- server
import { t } from 'elysia'
import { action } from 'kay'

export const signIn = action(t.Object({ name: t.String({ maxLength: 50 }) }), ({ name }) => ({ signedIn: name }))
---
---
import Counter from '../counter.kay'
---
form(action={signIn})
  input(name="name")
  button Sign in
Counter
`

// An app with a library installed under its node_modules, whose pages its config mounts under `/auth`.
const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { 'kay-lib': '*' } }),
  'src/routes/_layout.kay': 'header.app App\nmain\n  slot\n',
  'src/routes/index.kay': 'p.home home\na(href="/auth/login") in\na(href="/auth/nope") nowhere\n',
  'tsconfig.json': TSCONFIG,
  'src/routes/auth/register.kay': 'p.register mine\n',
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nimport { authPages } from \'kay-lib\'\n\nexport default defineConfig({ extensions: [authPages()] })\n',
  'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', type: 'module', exports: { '.': './index.ts' }, peerDependencies: { kay: '*' } }),
  'node_modules/kay-lib/index.ts': 'import type { KayExtension } from \'kay/server\'\n\nexport const authPages = (): KayExtension => ({ name: \'kay-lib\', routes: { dir: `${import.meta.dir}/routes`, prefix: \'/auth\' } })\n',
  'node_modules/kay-lib/routes/_layout.kay': '---\nimport \'./lib.css\'\n---\nsection.lib\n  slot\n',
  'node_modules/kay-lib/routes/lib.css': '.lib { color: teal }\n',
  'node_modules/kay-lib/routes/register.kay': 'p.register theirs\n',
  'node_modules/kay-lib/routes/login.kay': LOGIN,
  'node_modules/kay-lib/routes/terms.kay': '--- server\nexport const prerender = true\n---\np.terms terms\n',
  // The library's own check reports this one, not the app's.
  'node_modules/kay-lib/routes/broken.kay': '---\nconst wrong: number = \'x\'\n---\np {wrong}\n',
  'node_modules/kay-lib/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton.count(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
}

// A process serves one project, so the app is served in its own, reporting what each page answered: run by Bun from the project, or compiled as the executable's entry.
const SERVE = `import { stringify } from 'devalue'
import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const visit = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()
const login = await visit('/auth/login')
const action = (/<form[^>]*action="([^"]+)"/).exec(login)?.[1] ?? ''
const posted = await app.handle(new Request(\`http://localhost\${action}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({ name: 'Ada' }) }))

const style = await visit((/rel="stylesheet" href="([^"]+)"/).exec(login)?.[1] ?? '/none.css')

console.log(JSON.stringify({ login, action, posted: await posted.text(), style, register: await visit('/auth/register'), home: await visit('/') }))
process.exit(0)
`

// A library whose pages and messages an app in two locales mounts, translating one of the library's texts its own way and adding one key.
const LOCALIZED: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { 'kay-lib': '*' } }),
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nimport { authPages } from \'kay-lib\'\n\nexport default defineConfig({ i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' }, extensions: [authPages()] })\n',
  'src/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ home: \'Home\', auth: { title: \'Log in\' } })\n',
  'src/messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ home: \'Accueil\', auth: { title: \'Se connecter\' } })\n',
  'src/routes/index.kay': '--- server\nimport { t } from \'kay/i18n\'\n\nconst hint = t(\'auth.hint\')\nconst wrong = t(\'auth.nope\')\n---\np {t(\'home\')} {hint} {wrong}\n',
  'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', type: 'module', exports: { '.': './index.ts' }, peerDependencies: { kay: '*' } }),
  'node_modules/kay-lib/index.ts': 'import type { KayExtension } from \'kay/server\'\n\nexport const authPages = (): KayExtension => ({ name: \'kay-lib\', routes: { dir: `${import.meta.dir}/routes`, prefix: \'/auth\' }, messages: `${import.meta.dir}/messages` })\n',
  'node_modules/kay-lib/messages/en.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ auth: { title: \'Sign in\', hint: \'Use your email\', extra: \'Only in English\' } })\n',
  'node_modules/kay-lib/messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ auth: { title: \'Connexion\', hint: \'Utilisez votre e-mail\' } })\n',
  'node_modules/kay-lib/routes/login.kay': '--- server\nimport { t } from \'kay/i18n\'\n\nconst title = t(\'auth.title\')\nconst hint = t(\'auth.hint\')\n---\nh1 {title}\np {hint}\n',
}

// The texts the localized app's login page shows in each locale.
const SERVE_LOCALIZED = `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const visit = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()

console.log(JSON.stringify({ en: await visit('/auth/login'), fr: await visit('/fr/auth/login') }))
process.exit(0)
`

const projects = new Map<string, string>()

beforeAll(async () => {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })

  for (const [name, files] of [['routes', { ...FILES, 'serve.ts': SERVE }], ['messages', { ...LOCALIZED, 'serve.ts': SERVE_LOCALIZED }]] as const) {
    const dir = await mkdtemp(join(base, `extension-${name}-`))

    await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content)))
    projects.set(name, dir)
  }
})

afterAll(async () => {
  await Promise.all([...projects.values()].map(async dir => rm(dir, { recursive: true, force: true })))
})

async function run(command: string[], cwd: string): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, stdout, stderr }
}

// What `SERVE` reports, checked the same whichever way it ran.
function expectServed({ code, stdout, stderr }: { code: number, stdout: string, stderr: string }) {
  expect(stderr).not.toContain('error')
  expect(code).toBe(0)
  const { login, action, posted, style, register, home } = JSON.parse(stdout) as { login: string, action: string, posted: string, style: string, register: string, home: string }

  expect(login).toContain('<header class="app">App</header>')
  expect(login).toMatch(/<section class="lib">.*<form/s)
  // Its island hydrates, bundled with the app's.
  expect(login).toContain('data-component="node_modules/kay-lib/counter.kay"')
  expect(login).toMatch(/rel="modulepreload" href="\/_kay\/counter-/)
  // So does its layout's stylesheet.
  expect(login).toMatch(/rel="stylesheet" href="\/_kay\/_layout-[^"]+\.css"/)
  expect(style).toContain('teal')
  expect(register).toContain('<p class="register">mine</p>')
  expect(home).toContain('<p class="home">home</p>')
  expect(action).toBe('/_kay/action/node_modules/kay-lib/routes/login.kay/signIn')
  expect(parse(posted)).toEqual({ signedIn: 'Ada' })
}

describe('a library\'s routes', () => {
  const root = () => projects.get('routes')!

  it('serve under their prefix inside the app\'s layouts, a library layout filling a level the app has none at, and an app page at the same path replacing the library\'s', async () => {
    expectServed(await run([process.execPath, 'serve.ts'], root()))
  })

  it('are carried by the executable, which serves them with nothing of the project to read', async () => {
    // Its link to `/auth/nope` fails the check, which the test below covers.
    const build = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root())

    expect(build.stderr).not.toContain('error')
    expect(build.code).toBe(0)
    const elsewhere = join(root(), '..', `${basename(root())}-elsewhere`)

    await mkdir(elsewhere, { recursive: true })

    try {
      expectServed(await run([join(root(), 'server')], elsewhere))
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  }, 60_000)

  it('are written by a static export when prerendered, which refuses one taking an action unless the app replaces it', async () => {
    const export_ = async () => run([process.execPath, CLI, 'build', '--no-check', '--static', '--outdir', 'dist'], root())
    const refused = await export_()

    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('node_modules/kay-lib/routes/login.kay: it exports the action signIn')
    const override = join(root(), 'src/routes/auth/login.kay')

    await Bun.write(override, 'p.login static\n')

    try {
      const build = await export_()

      expect(build.stderr).not.toContain('error')
      expect(build.code).toBe(0)
      expect(await Bun.file(join(root(), 'dist/auth/terms.html')).text()).toMatch(/<header class="app">App<\/header><main><section class="lib"><p class="terms">terms<\/p>/)
    }
    finally {
      await rm(override)
    }
  }, 60_000)

  it('are pages kay check lets a link point at, leaving the errors inside them to the library', async () => {
    const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], root())
    const output = `${stdout}${stderr}`

    expect(code).toBe(1)
    expect([...output.matchAll(/serves (\S+?)"/g)].map(match => match[1])).toEqual(['/auth/nope', '/auth/nope'])
  })
})

describe('a library\'s messages', () => {
  const root = () => projects.get('messages')!

  it('translate its pages in each locale, under the app\'s own catalogs key by key', async () => {
    const { code, stdout, stderr } = await run([process.execPath, 'serve.ts'], root())

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    const { en, fr } = JSON.parse(stdout) as { en: string, fr: string }

    expect(en).toContain('<h1>Log in</h1><p>Use your email</p>')
    expect(fr).toContain('<h1>Se connecter</h1><p>Utilisez votre e-mail</p>')
  })

  it('are carried by the executable', async () => {
    const build = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root())

    expect(build.stderr).not.toContain('error')
    expect(build.code).toBe(0)
    const elsewhere = join(root(), '..', `${basename(root())}-elsewhere`)

    await mkdir(elsewhere, { recursive: true })

    try {
      const served = await run([join(root(), 'server')], elsewhere)

      expect(served.code).toBe(0)
      expect((JSON.parse(served.stdout) as { fr: string }).fr).toContain('<h1>Se connecter</h1><p>Utilisez votre e-mail</p>')
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  }, 60_000)

  it('give t() their keys in kay check, and a key the library has in one locale alone is the app\'s to translate', async () => {
    const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], root())
    const output = `${stdout}${stderr}`

    expect(code).toBe(1)
    expect(output).toContain('"auth.nope"')
    expect(output).not.toContain('"auth.hint"')
    expect(output).toContain('lacks auth.extra, which node_modules/kay-lib/messages/en.ts has')
    expect([...output.matchAll(/^ *--> (\S+)$/gm)].map(match => match[1])).toEqual(['src/routes/index.kay:5:17', 'src/messages/fr.ts:1:1'])
  })
})
