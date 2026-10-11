import type { BunPlugin } from 'bun'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parse } from 'devalue'
import { t } from 'elysia'
import { servedByTheApp, servedLocales } from '../src/check/diagnose'
import { readShadowSettings } from '../src/check/shadow'
import { writeShadowTypes } from '../src/check/shadow-types'
import { mergeConfig } from '../src/config'
import { UNSERVED_MESSAGE } from '../src/runtime/checks'
import { apiStubs } from '../src/server/api'
import { routeMounts, scanRoutes } from '../src/server/routes'
import { scratchDir } from './scratch'

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
  'node_modules/kay-lib/routes/terms.kay': '--- server\nexport const page = { prerender: true }\n---\np.terms terms\n',
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

// The same library in an app without `i18n`, written in French: its pages read the French catalogs, the app's own over the library's.
const IMPLICIT: Record<string, string> = {
  'package.json': LOCALIZED['package.json']!,
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nimport { authPages } from \'kay-lib\'\n\nexport default defineConfig({ lang: \'fr\', site: \'https://example.com\', lints: { seo: \'allow\' }, extensions: [authPages()] })\n',
  'src/messages/fr.ts': 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ auth: { title: \'Se connecter\' } })\n',
  // A component no page renders, so the static export leaves its unknown key to kay check.
  'src/wrong.kay': '---\nimport { t } from \'kay/i18n\'\n---\np {t(\'auth.nope\')}\n',
  'node_modules/kay-lib/package.json': LOCALIZED['node_modules/kay-lib/package.json']!,
  'node_modules/kay-lib/index.ts': LOCALIZED['node_modules/kay-lib/index.ts']!,
  'node_modules/kay-lib/messages/en.ts': LOCALIZED['node_modules/kay-lib/messages/en.ts']!,
  'node_modules/kay-lib/messages/fr.ts': LOCALIZED['node_modules/kay-lib/messages/fr.ts']!,
  'node_modules/kay-lib/routes/login.kay': '--- server\nimport { locale, localize, t } from \'kay/i18n\'\n\nexport const page = { prerender: true }\n\nconst title = t(\'auth.title\')\nconst hint = t(\'auth.hint\')\nconst register = localize(\'/auth/register\')\nconst lang = locale()\n---\n---\nimport Hint from \'../hint.kay\'\n---\nh1 {title}\np {hint}\na(href={register}) {lang}\nHint\n',
  'node_modules/kay-lib/hint.kay': '---\nimport { signal } from \'kay\'\nimport { t } from \'kay/i18n\'\n\nconst open = signal(false)\n---\nbutton(type="button" onClick={() => open.set(!open())}) {t(\'auth.hint\')}\n',
  'node_modules/kay-lib/routes/register.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\nimport { t as text } from \'kay/i18n\'\n\nexport const register = action(t.Object({}), (_, ctx) => ({ locale: ctx.locale, hint: text(\'auth.hint\') }))\n---\nform(action={register})\n  button Register\n',
  'src/routes/_404.kay': '---\nimport { t } from \'kay/i18n\'\n---\np.missing {t(\'auth.title\')}\n',
}

// The implicit app's login page, its 404 page and what its register action answers.
const SERVE_IMPLICIT = `import { parse, stringify } from 'devalue'
import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const visit = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()
const register = await visit('/auth/register')
const action = (/<form[^>]*action="([^"]+)"/).exec(register)?.[1] ?? ''
const posted = await app.handle(new Request(\`http://localhost\${action}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({}) }))

console.log(JSON.stringify({ login: await visit('/auth/login'), missing: await visit('/nope'), registered: parse(await posted.text()) }))
process.exit(0)
`

// The library's catalogs standing in for an app in two locales that writes none of its own.
const BORROWED: Record<string, string> = {
  ...LOCALIZED,
  'src/messages/en.ts': undefined!,
  'src/messages/fr.ts': undefined!,
  'src/routes/index.kay': 'p home\n',
}

// The login page as the app serves it.
const SERVE_LOGIN = `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const visit = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()

console.log(JSON.stringify({ login: await visit('/auth/login'), fr: await visit('/fr/auth/login') }))
process.exit(0)
`

// An app whose extension lives beside it rather than under it, as a linked or workspace library does.
const OUTSIDE: Record<string, string> = {
  'app/package.json': JSON.stringify({ name: 'app' }),
  'app/tsconfig.json': TSCONFIG,
  'app/kay.config.ts': 'import { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ extensions: [{ name: \'lib\', routes: { dir: \'../lib/routes\', prefix: \'/auth\' } }] })\n',
  'app/serve.ts': `import { stringify } from 'devalue'
import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const login = await (await app.handle(new Request('http://localhost/auth/login'))).text()
const action = (/<form[^>]*action="([^"]+)"/).exec(login)?.[1] ?? ''
const posted = await app.handle(new Request(\`http://localhost\${action}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({ name: 'Ada' }) }))

console.log(JSON.stringify({ action, posted: await posted.text() }))
process.exit(0)
`,
  'lib/routes/login.kay': '--- server\nimport { t } from \'elysia\'\nimport { action } from \'kay\'\n\nexport const signIn = action(t.Object({ name: t.String({ maxLength: 50 }) }), ({ name }) => ({ signedIn: name }))\n---\nform(action={signIn})\n  input(name="name")\n  button Sign in\n',
}

// An app with a library serving API modules under `/api/auth` and laying its config under the app's, which also has a head of its own.
const SERVED_API: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { 'kay-lib': '*' } }),
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': `import { defineConfig } from 'kay/server'
import { authApi, statsApi } from 'kay-lib'

export default defineConfig({ seo: { name: 'App' }, head: [{ tag: 'meta', props: { name: 'app', content: 'mine' } }], openapi: true, extensions: [authApi(), statsApi()] })
`,
  'src/routes/index.kay': '---\nimport Who from \'../components/who.kay\'\n---\np.home home\nWho\n',
  // It reads a module the app replaced and one of a second library directory too.
  'src/components/who.kay': '---\nimport { resource } from \'kay\'\nimport me from \'kay-lib/api/me\'\nimport session from \'kay-lib/api/session\'\nimport count from \'kay-lib/stats-api/count\'\n\nconst who = resource(session, \'/\')\nconst mine = resource(me, \'/\')\nconst total = resource(count, \'/\')\n---\np.who {who.value()?.from} {mine.value()?.from} {total.value()?.count}\n',
  'src/api/auth/staff/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(() => {})\n',
  'src/api/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ request, deny }) => {\n  if (request.headers.has(\'x-deny\'))\n    deny(403, \'denied\')\n})\n',
  'src/api/auth/me.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => ({ from: \'app\' }))\n',
  'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', type: 'module', exports: { '.': './index.ts', './api/*': './api/*.ts', './stats-api/*': './stats-api/*.ts' }, peerDependencies: { kay: '*' } }),
  'node_modules/kay-lib/index.ts': `import type { KayExtension } from 'kay/server'

export const authApi = (): KayExtension => ({
  name: 'kay-lib',
  api: { dir: \`\${import.meta.dir}/api\`, prefix: 'auth' },
  config: {
    seo: { name: 'Lib', description: 'from the library' },
    head: [{ tag: 'script', props: { children: 'window.lib = 1' } }, { tag: 'style', props: { children: '.lib { color: teal }' } }],
    redirects: { '/old': '/' },
  },
})

export const statsApi = (): KayExtension => ({ name: 'kay-lib-stats', api: { dir: \`\${import.meta.dir}/stats-api\`, prefix: 'stats' } })
`,
  'node_modules/kay-lib/api/session.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => ({ from: \'lib\' }))\n',
  'node_modules/kay-lib/api/me.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => ({ from: \'lib\' }))\n',
  'node_modules/kay-lib/api/admin/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(401, \'no admin\'))\n',
  'node_modules/kay-lib/api/staff/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(401, \'no staff\'))\n',
  'node_modules/kay-lib/api/staff/list.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => [\'ada\'])\n',
  'node_modules/kay-lib/stats-api/count.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => ({ count: 1 }))\n',
  'node_modules/kay-lib/api/admin/stats.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia().get(\'/\', () => ({ stats: 1 }))\n',
}

const SERVE_API = `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const get = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(\`http://localhost\${path}\`, { headers }))
const home = await get('/')
const old = await get('/old')
const status = async (path: string, headers?: Record<string, string>) => (await get(path, headers)).status

console.log(JSON.stringify({
  session: await (await get('/api/auth/session')).json(),
  me: await (await get('/api/auth/me')).json(),
  denied: await status('/api/auth/session', { 'x-deny': '1' }),
  admin: await status('/api/auth/admin/stats'),
  staff: await status('/api/auth/staff/list'),
  count: await (await get('/api/stats/count')).json(),
  openapi: await (await get('/api/openapi.json')).json(),
  home: await home.text(),
  csp: home.headers.get('content-security-policy'),
  old: [old.status, old.headers.get('location')],
}))
process.exit(0)
`

// An app listing two libraries' server plugins and no server entry: one handed as it is, one built from a function only when the app is.
const SERVED_PLUGINS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { 'kay-lib': '*' } }),
  'tsconfig.json': TSCONFIG,
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nimport { accounts, greeter } from \'kay-lib\'\n\nexport default defineConfig({ extensions: [greeter, accounts()] })\n',
  'src/routes/index.kay': `--- server
import { t } from 'elysia'
import { action } from 'kay'

export const who = action(t.Object({}), (_, ctx) => ({ account: ctx.locals.account, visitor: ctx.locals.visitor }))

const greeting: string = ctx.locals.greeting
const account: string = ctx.locals.account
---
p.home {greeting} {account}
a(href="/greeter/ping") ping
form(action={who})
  button Who
`,
  // Served, though its link and its local's type fail the check.
  'src/routes/wrong.kay': '--- server\nconst count: number = ctx.locals.greeting\n---\np {count}\na(href="/greeter/nope") nope\n',
  'src/api/me.ts': 'import { api } from \'kay/server\'\n\nexport default api().get(\'/\', ({ account, visitor }) => ({ account, visitor }))\n',
  'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', type: 'module', exports: { '.': './index.ts' }, peerDependencies: { kay: '*' } }),
  'node_modules/kay-lib/index.ts': `import type { KayExtension } from 'kay/server'
import { Elysia } from 'elysia'

const greeting = new Elysia({ name: 'kay-lib-greeter' })
  .decorate('greeting', 'hello')
  .derive({ as: 'scoped' }, ({ request }) => ({ visitor: request.headers.get('x-visitor') ?? 'anonymous' }))
  .get('/greeter/ping', () => 'pong')

export const greeter: KayExtension<typeof greeting> = { name: 'kay-lib-greeter', server: greeting }

export const accounts = (): KayExtension<typeof import('./accounts').accounts> => ({ name: 'kay-lib-accounts', server: async () => (await import('./accounts')).accounts })
`,
  'node_modules/kay-lib/accounts.ts': `import { Elysia } from 'elysia'

console.log('accounts built')

export const accounts = new Elysia({ name: 'kay-lib-accounts' }).derive({ as: 'global' }, ({ request }) => ({ account: request.headers.get('x-account') ?? 'nobody' }))
`,
}

const SERVE_PLUGINS = `import { parse, stringify } from 'devalue'
import { pages } from 'kay/server'

const app = await pages()
const get = async (path: string) => app.handle(new Request(\`http://localhost\${path}\`, { headers: { 'x-account': 'ada', 'x-visitor': 'bob' } }))
const home = await (await get('/')).text()
const action = (/<form[^>]*action="([^"]+)"/).exec(home)?.[1] ?? ''
const posted = await app.handle(new Request(\`http://localhost\${action}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1', 'x-account': 'ada', 'x-visitor': 'bob' }, body: stringify({}) }))

console.log(JSON.stringify({ home, ping: await (await get('/greeter/ping')).text(), me: await (await get('/api/me')).json(), posted: parse(await posted.text()) }))
process.exit(0)
`

const projects = new Map<string, string>()

beforeAll(async () => {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })

  for (const [name, files] of [['routes', { ...FILES, 'serve.ts': SERVE }], ['messages', { ...LOCALIZED, 'serve.ts': SERVE_LOCALIZED }], ['implicit', { ...IMPLICIT, 'serve.ts': SERVE_IMPLICIT }], ['borrowed', { ...BORROWED, 'serve.ts': SERVE_LOGIN }], ['outside', OUTSIDE], ['api', { ...SERVED_API, 'serve.ts': SERVE_API }], ['plugins', { ...SERVED_PLUGINS, 'serve.ts': SERVE_PLUGINS }]] as const) {
    const dir = await mkdtemp(join(base, `extension-${name}-`))

    await Promise.all(Object.entries(files).filter(([, content]) => content !== undefined).map(async ([path, content]) => Bun.write(join(dir, path), content)))
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

// A library's own fixture app, listing its extension by a path beside it or through a link to the library: neither comes from the registry.
const LOCAL_CHECKED: Record<string, string> = {
  'app/package.json': JSON.stringify({ name: 'app', dependencies: { 'linked-lib': 'link:../linked' } }),
  'app/tsconfig.json': TSCONFIG,
  'app/kay.config.ts': 'import { defineConfig } from \'kay/server\'\nimport { linkedPages } from \'linked-lib\'\n\nexport default defineConfig({ extensions: [{ name: \'lib\', routes: { dir: \'../lib/routes\', prefix: \'/auth\' } }, linkedPages(), { name: \'abs\', routes: { dir: `${import.meta.dir}/../abs/routes`, prefix: \'/abs\' } }, { name: \'sub\', routes: { dir: \'../abs/sub/routes\', prefix: \'/sub\' } }, { name: \'edit\', editor: \'../edit/editor.kay\' }, { name: \'ws\', routes: { dir: \'node_modules/ws-lib/routes\', prefix: \'/ws\' } }, { name: \'ws-more\', routes: { dir: \'../ws/more\', prefix: \'/more\' } }, { name: \'mono\', routes: { dir: \'../mono/ext/routes\', prefix: \'/mono\' } }] })\n',
  'app/src/routes/index.kay': '---\nimport { shared } from \'../../../mono/shared/util\'\n---\np.home home {shared}\n',
  'app/src/params/code.ts': 'export default (value: string): number | undefined => (/^\\d+$/).test(value) ? Number(value) : undefined\n',
  'lib/package.json': JSON.stringify({ name: 'lib' }),
  'lib/card.kay': '---\nconst { title } = props<{ title: string }>()\n---\np.card {title}\n',
  'lib/routes/login.kay': '---\nimport Card from \'../card.kay\'\nimport { title } from \'../titles\'\nimport { format } from \'../helpers/format\'\n---\nCard(title={format(title)})\n',
  // A module of the package, its own to check as a library's are: the strictness it is written for may not be the app's.
  'lib/titles.ts': 'const wrong: number = \'module\'\n\nexport const title = `Sign in ${wrong}`\n',
  // A folder setting its module type alone, still the package's.
  'lib/helpers/package.json': JSON.stringify({ type: 'module' }),
  'lib/helpers/format.ts': 'const wrong: number = \'nestedmodule\'\n\nexport const format = (title: string) => `${title} ${wrong}`\n',
  // Typed by its own path: `id` is no param of it.
  'lib/routes/[slug].kay': '--- server\nconst slug: string = ctx.params.slug\nconst id = ctx.params.id\n---\np {slug} {id}\n',
  'lib/routes/broken.kay': '---\nconst wrong: number = \'beside\'\n---\np {wrong}\n',
  // Paths the app may serve or not, which only it knows, `/authx` among them as it only begins like the prefix, and one into the extension's own routes, still checked.
  'lib/routes/out.kay': '--- server\nimport { localPath } from \'kay\'\n\nconst back = localPath(ctx.url.searchParams.get(\'next\'), \'/welcome\')\n\nif (back === \'/old\')\n  ctx.redirect(\'/gone\')\n---\na(href={back}) Back\na(href="/settings") Settings\na(href="/authx/page") Beside\na(href="/auth/no/such/page") Nope\n',
  // The app's matchers type an extension's params as they do its own.
  'lib/routes/codes/[id=code].kay': '--- server\nconst id: number = ctx.params.id\n---\np {id}\n',
  'lib/routes/codes/[id=code]/label.kay': '--- server\nconst label: string = ctx.params.id\n---\np {label}\n',
  // Two package roots, one inside the other, each listing pages.
  'abs/package.json': JSON.stringify({ name: 'abs' }),
  'abs/routes/broken.kay': '---\nconst wrong: number = \'absolute\'\n---\np {wrong}\n',
  'abs/sub/package.json': JSON.stringify({ name: 'sub' }),
  'abs/sub/routes/photo.kay': 'img(src="https://example.com/photo.png")\n',
  'linked/package.json': JSON.stringify({ name: 'linked-lib', type: 'module', exports: { '.': './index.ts' }, peerDependencies: { kay: '*' } }),
  'linked/index.ts': 'import type { KayExtension } from \'kay/server\'\n\nexport const linkedPages = (): KayExtension => ({ name: \'linked-lib\', routes: { dir: `${import.meta.dir}/routes`, prefix: \'/linked\' } })\n',
  'linked/routes/broken.kay': '---\nconst wrong: number = \'linked\'\n---\np {wrong}\n',
  'linked/routes/fine.kay': '---\nimport Badge from \'../badge.kay\'\nimport { title } from \'../titles\'\n---\nBadge(title={title})\n',
  'linked/titles.ts': 'const wrong: number = \'linkedmodule\'\n\nexport const title = `${wrong}`\n',
  'linked/badge.kay': '---\nconst { title } = props<{ title: string }>()\nconst wrong: number = \'reached\'\n---\nspan {wrong} {title}\n',
  'linked/unused.kay': '---\nconst wrong: number = \'unreached\'\n---\nspan {wrong}\n',
  // An editor alone, no routes beside it, and what it reaches.
  'edit/package.json': JSON.stringify({ name: 'edit' }),
  'edit/editor.kay': '---\nimport Part from \'./part.kay\'\n\nconst wrong: number = \'editor\'\nonCleanup(() => undefined)\nnope()\n---\nPart\np {wrong}\n',
  'edit/part.kay': '---\nimport { label } from \'./labels\'\n\nconst wrong: number = \'edited\'\n---\nspan {wrong} {label}\n',
  'edit/labels.ts': 'const wrong: number = \'editmodule\'\n\nexport const label = `${wrong}`\n',
  // Listed through the link a workspace gives, its routes under `node_modules` by path but not for real.
  'ws/package.json': JSON.stringify({ name: 'ws-lib' }),
  'ws/routes/broken.kay': '---\nimport { label } from \'../labels\'\nimport { dep } from \'../node_modules/dep/index\'\n\nconst wrong: number = \'workspace\'\n---\np {wrong} {label} {dep}\n',
  // More of its routes listed by the real path, the package checked once, and a dependency it installs itself, reached by its path.
  'ws/more/page.kay': '---\nconst wrong: number = \'wsmore\'\n---\np {wrong}\n',
  'ws/node_modules/dep/package.json': JSON.stringify({ name: 'dep', type: 'module', exports: { '.': './index.ts' } }),
  'ws/node_modules/dep/index.ts': 'const wrong: number = \'dependency\'\n\nexport const dep = `${wrong}`\n',
  'ws/labels.ts': 'const wrong: number = \'wsmodule\'\n\nexport const label = `${wrong}`\n',
  // Routes in no package of their own, inside a repository whose other packages stay the app's to check when it imports them.
  'mono/package.json': JSON.stringify({ name: 'mono', private: true }),
  'mono/ext/routes/page.kay': 'p mono\n',
  'mono/shared/package.json': JSON.stringify({ name: 'shared' }),
  'mono/shared/util.ts': 'const wrong: number = \'sibling\'\n\nexport const shared = `${wrong}`\n',
}

describe('an extension listed from beside the app', () => {
  it('has kay check report the errors of its pages and editor and the components they reach as the app\'s own, linked or not', async () => {
    const dir = await scratchDir('extension-local-')

    try {
      await Promise.all(Object.entries(LOCAL_CHECKED).map(async ([path, content]) => Bun.write(join(dir, path), content)))
      await mkdir(join(dir, 'app/node_modules'))
      await symlink('../../linked', join(dir, 'app/node_modules/linked-lib'))
      await symlink('../../ws', join(dir, 'app/node_modules/ws-lib'))

      const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], join(dir, 'app'))
      const output = `${stdout}${stderr}`

      expect(code).toBe(1)
      // A frame shows the lines before its own, so the editor's `nope()` shows its `wrong` again.
      expect([...new Set(output.matchAll(/\| const wrong: number = '(\w+)'/g).map(match => match[1]))].sort()).toEqual(['absolute', 'beside', 'edited', 'editor', 'linked', 'reached', 'sibling', 'workspace', 'wsmore'])
      expect(output.split('error[missing-alt]').length).toBe(2)
      expect(output).not.toContain('codes/[id=code].kay')
      expect(output.split('label.kay').length).toBe(2)
      expect(output).toContain('Type \'number\' is not assignable to type \'string\'.\n --> ../lib/routes/codes/[id=code]/label.kay:2:')
      expect(output).toContain('--> ../lib/routes/[slug].kay:3:')
      expect([...output.matchAll(/serves (\S+?)"/g)].map(match => match[1])).toEqual(['/auth/no/such/page', '/auth/no/such/page'])
      // A name the compiled script does not get, as `onCleanup` now does.
      expect(output).toContain('Cannot find name \'nope\'.')
      expect(output).not.toContain('Cannot find name \'onCleanup\'')
      expect(output).toContain('14 errors')
      // What the ESLint processor types the pages by.
      expect(readShadowSettings(join(dir, 'app')).mounts).toContain(join(dir, 'lib/routes'))
      // The workspace package once, by the link the app imports it through, its routes listed by either path.
      expect((await writeShadowTypes(join(dir, 'app'), { extensions: [{ name: 'ws', routes: { dir: join(dir, 'app/node_modules/ws-lib/routes'), prefix: '/ws' } }, { name: 'ws-more', routes: { dir: join(dir, 'ws/more'), prefix: '/more' } }] })).libraries.filter(library => library.extension).map(library => library.dir.slice(dir.length + 1)).sort()).toEqual(['app/node_modules/ws-lib'])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// What `SERVE_API` reports, checked the same whichever way it ran.
function expectApiServed({ code, stdout, stderr }: { code: number, stdout: string, stderr: string }) {
  expect(stderr).not.toContain('error')
  expect(code).toBe(0)
  const served = JSON.parse(stdout) as { session: unknown, me: unknown, denied: number, admin: number, staff: number, count: unknown, openapi: { paths: Record<string, { get: { 'x-kay-guards'?: string[] } }> }, home: string, csp: string, old: [number, string] }
  const hash = (text: string) => `'sha256-${new Bun.CryptoHasher('sha256').update(text).digest('base64')}'`

  expect(served.session).toEqual({ from: 'lib' })
  expect(served.me).toEqual({ from: 'app' })
  // The app's guard runs before the library's modules, and the library's own before those under it.
  expect(served.denied).toBe(403)
  expect(served.admin).toBe(401)
  // The app's guard at the same level replaces the library's.
  expect(served.staff).toBe(200)
  expect(served.count).toEqual({ count: 1 })
  expect(served.openapi.paths['/api/auth/session']?.get['x-kay-guards']).toEqual(['_guard.ts'])
  expect(served.openapi.paths['/api/auth/admin/stats']?.get['x-kay-guards']).toEqual(['_guard.ts', 'auth/admin/_guard.ts'])
  // The app's `seo.name` wins, the library's `description` fills in, and both heads are carried.
  expect(served.home).toContain('<title>App</title>')
  expect(served.home).toContain('<meta name="description" content="from the library">')
  expect(served.home).toContain('<script>window.lib = 1</script>')
  expect(served.home).toContain('<style>.lib { color: teal }</style>')
  expect(served.home).toContain('<meta name="app" content="mine">')
  expect(served.csp).toContain(hash('window.lib = 1'))
  expect(served.old).toEqual([308, '/'])
}

describe('a library\'s API modules and config', () => {
  const root = () => projects.get('api')!

  it('serve under its prefix behind the app\'s guards, an app module at the same path replacing one, its config under the app\'s', async () => {
    expectApiServed(await run([process.execPath, 'serve.ts'], root()))
  })

  it('are carried by the executable, an island reading one getting its mount and none of its code', async () => {
    const build = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root())

    expect(build.stderr).not.toContain('error')
    expect(build.code).toBe(0)
    const chunks = await Array.fromAsync(new Bun.Glob('.kay/**/who-*.js').scan({ cwd: root(), dot: true }))

    expect(chunks.length).toBeGreaterThan(0)
    const island = await Bun.file(join(root(), chunks[0]!)).text()

    expect(island).toContain('/api/auth/session')
    expect(island).toContain('/api/auth/me')
    expect(island).toContain('/api/stats/count')
    expect(island).not.toContain('Elysia')
    const elsewhere = join(root(), '..', `${basename(root())}-elsewhere`)

    await mkdir(elsewhere, { recursive: true })

    try {
      expectApiServed(await run([join(root(), 'server')], elsewhere))
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  }, 60_000)

  it('type an island\'s calls in kay check', async () => {
    const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], root())

    expect(`${stdout}${stderr}`).not.toContain('error')
    expect(code).toBe(0)
  })

  it('give an island its mount when the library is linked, whichever side of the link the island imports it from', async () => {
    const base = await scratchDir('api-link-')
    const real = join(base, 'lib')
    const linked = join(base, 'app/node_modules/lib')

    try {
      await Bun.write(join(real, 'api/who.ts'), 'import { serve } from \'bun\'\n\nexport default { serve }\n')
      await Bun.write(join(real, 'island.ts'), 'import who from \'./api/who\'\n\nconsole.log(who)\n')
      await mkdir(dirname(linked), { recursive: true })
      await symlink(real, linked)

      for (const [dir, entry] of [[join(linked, 'api'), join(real, 'island.ts')], [join(real, 'api'), join(linked, 'island.ts')]] as const) {
        const built = await Bun.build({ entrypoints: [entry], target: 'browser', plugins: [apiStubs([{ dir, prefix: '/lib' }])] })

        expect(await built.outputs[0]!.text()).toContain('"/api/lib/who"')
      }
    }
    finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('a library\'s server plugin', () => {
  const root = () => projects.get('plugins')!

  it('is used before the pages, actions and API modules, which read what it adds as ctx.locals, and serves its own routes', async () => {
    const { code, stdout, stderr } = await run([process.execPath, 'serve.ts'], root())

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    const { home, ping, me, posted } = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { home: string, ping: string, me: unknown, posted: unknown }

    expect(stdout.split('accounts built').length).toBe(2)
    expect(home).toContain('<p class="home">hello ada</p>')
    expect(ping).toBe('pong')
    expect(me).toEqual({ account: 'ada', visitor: 'bob' })
    expect(posted).toEqual({ account: 'ada', visitor: 'bob' })
  })

  it('types the app\'s ctx.locals and links in kay check with no Register of the app\'s, building none given as a function', async () => {
    const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], root())
    const output = `${stdout}${stderr}`

    expect(code).toBe(1)
    expect(output).not.toContain('accounts built')
    expect(output).not.toContain('index.kay')
    expect(output).toContain('src/routes/wrong.kay')
    expect(output).toContain('/greeter/nope')
    expect(output).toMatch(/Type 'string' is not assignable to type 'number'/)
    expect(output).toMatch(/2 errors/)
  })
})

describe('a library outside the app\'s directory', () => {
  it('takes posts to its actions at a URL no browser resolves away', async () => {
    const { code, stdout, stderr } = await run([process.execPath, 'serve.ts'], join(projects.get('outside')!, 'app'))

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    const { action, posted } = JSON.parse(stdout) as { action: string, posted: string }

    expect(action).toBe('/_kay/action/~/lib/routes/login.kay/signIn')
    expect(new URL(action, 'http://localhost').pathname).toBe(action)
    expect(parse(posted)).toEqual({ signedIn: 'Ada' })
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

describe('a library\'s messages in an app without i18n', () => {
  const root = () => projects.get('implicit')!

  it('translate its pages, its actions and the 404 page in the site\'s language, the app\'s catalog over its own, links kept as written and no alternates', async () => {
    const { code, stdout, stderr } = await run([process.execPath, 'serve.ts'], root())

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    const { login, missing, registered } = JSON.parse(stdout) as { login: string, missing: string, registered: unknown }

    expect(login).toContain('<h1>Se connecter</h1><p>Utilisez votre e-mail</p><a href="/auth/register">fr</a>')
    // The 404 page and the actions read the same messages, in the same language.
    expect(missing).toContain('<p class="missing">Se connecter</p>')
    expect(registered).toEqual({ locale: 'fr', hint: 'Utilisez votre e-mail' })
    expect(login).toContain('<html lang="fr">')
    expect(login).toContain('<link rel="canonical" href="https://example.com/auth/login">')
    expect(login).not.toContain('hreflang')
    // Its island gets the message it reads, and nothing to build localized links with.
    expect(login).toContain('<script type="application/json" data-kay-i18n>{"locale":"fr","messages":{"auth.hint":"Utilisez votre e-mail"}}</script>')
  })

  it('are carried by the executable and written by a static export', async () => {
    const build = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root())

    expect(build.stderr).not.toContain('error')
    expect(build.code).toBe(0)
    const elsewhere = join(root(), '..', `${basename(root())}-elsewhere`)

    await mkdir(elsewhere, { recursive: true })

    try {
      const served = await run([join(root(), 'server')], elsewhere)

      expect(served.code).toBe(0)
      expect((JSON.parse(served.stdout) as { login: string }).login).toContain('<h1>Se connecter</h1><p>Utilisez votre e-mail</p>')
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }

    // A static export takes no action, so the app replaces the page posting one.
    const override = join(root(), 'src/routes/auth/register.kay')

    await Bun.write(override, 'p.register static\n')

    try {
      const exported = await run([process.execPath, CLI, 'build', '--no-check', '--static', '--outdir', 'dist'], root())

      expect(exported.stderr).not.toContain('error')
      expect(exported.code).toBe(0)
      expect(await Bun.file(join(root(), 'dist/auth/login.html')).text()).toContain('<h1>Se connecter</h1><p>Utilisez votre e-mail</p>')
    }
    finally {
      await rm(override)
    }
  }, 60_000)

  it('give t() their keys in kay check', async () => {
    const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], root())
    const output = `${stdout}${stderr}`

    expect(code).toBe(1)
    expect(output).toContain('"auth.nope"')
    expect([...output.matchAll(/^ *--> (\S+)$/gm)].map(match => match[1])).toEqual(['src/wrong.kay:4:6'])
  })
})

describe('a library\'s catalogs in an app writing none of its own', () => {
  const root = () => projects.get('borrowed')!

  it('stand in for the app\'s in each locale', async () => {
    const { code, stdout, stderr } = await run([process.execPath, 'serve.ts'], root())

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    const { login, fr } = JSON.parse(stdout) as { login: string, fr: string }

    expect(login).toContain('<h1>Sign in</h1><p>Use your email</p>')
    expect(fr).toContain('<h1>Connexion</h1><p>Utilisez votre e-mail</p>')
  })

  it('need no catalog of the app\'s in kay check, which still reports a key the library leaves untranslated', async () => {
    const { code, stdout, stderr } = await run([process.execPath, CLI, 'check'], root())
    const output = `${stdout}${stderr}`

    expect(code).toBe(1)
    expect(output).not.toContain('is missing')
    expect(output).toContain('lacks auth.extra, which node_modules/kay-lib/messages/en.ts has')
    expect([...output.matchAll(/^ *--> (\S+)$/gm)].map(match => match[1])).toEqual(['src/messages/fr.ts:1:1'])
  })
})

describe('a library\'s route tree', () => {
  // Writes empty files under a scratch directory and hands it to `test`, removing it after.
  async function withTree(files: string[], test: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'kay-mounts-'))

    try {
      await Promise.all(files.map(async file => Bun.write(join(dir, file), '')))
      await test(dir)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('resolves layouts, guards and special pages per URL directory across both trees, the app\'s file winning at a level both have one', async () => {
    const app = ['_guard.ts', '_layout.kay', '_404.kay', 'auth/_layout.kay', 'auth/register.kay']
    const library = ['_layout.kay', '_guard.ts', '_error.kay', 'login.kay', 'register.kay', 'admin/_layout.kay', 'admin/index.kay']

    await withTree([...app.map(file => `src/routes/${file}`), ...library.map(file => `lib/routes/${file}`)], async (root) => {
      const ours = (file: string) => join(root, 'src/routes', file)
      const theirs = (file: string) => join(root, 'lib/routes', file)
      const routes = await scanRoutes(ours(''), routeMounts(root, [{ name: 'lib', routes: { dir: 'lib/routes', prefix: 'auth/' } }]))
      const at = (pattern: string) => routes.filter(route => route.pattern === pattern)

      expect(routes.map(route => route.pattern).sort()).toEqual(['/auth/admin', '/auth/login', '/auth/register'])
      expect(at('/auth/register').map(route => route.file)).toEqual([ours('auth/register.kay')])

      const [login] = at('/auth/login')

      expect(login!.layouts).toEqual([ours('_layout.kay'), ours('auth/_layout.kay')])
      expect(login!.special).toEqual({ notFound: { file: ours('_404.kay'), layouts: [ours('_layout.kay')] }, error: { file: theirs('_error.kay'), layouts: [ours('_layout.kay'), ours('auth/_layout.kay')] } })
      expect(login!.guards).toEqual([
        { file: ours('_guard.ts'), special: { notFound: { file: ours('_404.kay'), layouts: [] }, error: undefined } },
        { file: theirs('_guard.ts'), special: { notFound: { file: ours('_404.kay'), layouts: [ours('_layout.kay')] }, error: undefined } },
      ])
      expect(at('/auth/admin')[0]!.layouts).toEqual([ours('_layout.kay'), ours('auth/_layout.kay'), theirs('admin/_layout.kay')])
      // A library's layout runs the guards above it for its actions, and is asked for none of its own, as its pages are.
      expect(at('/auth/admin')[0]!.layoutAccess!.map(access => [access.guards.map(guard => guard.file), access.open])).toEqual([
        [[ours('_guard.ts')], undefined],
        [[ours('_guard.ts'), theirs('_guard.ts')], undefined],
        [[ours('_guard.ts'), theirs('_guard.ts')], true],
      ])
    })
  })

  it('mounts at the root by default, the first extension listed serving a path two of them have', async () => {
    await withTree(['src/routes/index.kay', 'one/about.kay', 'two/about.kay', 'two/contact.kay'], async (root) => {
      const routes = await scanRoutes(join(root, 'src/routes'), routeMounts(root, [{ name: 'one', routes: { dir: 'one' } }, { name: 'two', routes: { dir: 'two', prefix: '/' } }]))

      expect(Object.fromEntries(routes.map(route => [route.pattern, route.file]))).toEqual({ '/': join(root, 'src/routes/index.kay'), '/about': join(root, 'one/about.kay'), '/contact': join(root, 'two/contact.kay') })
    })
  })

  it('leaves the app what an extension\'s routes name outside their prefix, a locale\'s prefix read past', () => {
    const mounts = [{ dir: '/nowhere/lib/routes', prefix: '/auth' }]
    const locales = servedLocales({ locales: ['en', 'fr'], defaultLocale: 'en' })
    const left = (path: string) => servedByTheApp('/nowhere/lib/routes/login.kay', `${UNSERVED_MESSAGE} ${path}`, mounts, locales)

    expect(locales).toEqual(['fr'])
    expect(['/', '/authx', '/authx/page', '/fr', '/fr/authx', '/en/auth/x'].filter(left)).toEqual(['/', '/authx', '/authx/page', '/fr', '/fr/authx', '/en/auth/x'])
    expect(['/auth', '/auth/x', '/fr/auth', '/fr/auth/x'].some(left)).toBe(false)
    // A page outside every extension checks its paths whole.
    expect(servedByTheApp('/nowhere/src/routes/index.kay', `${UNSERVED_MESSAGE} /nope`, mounts, locales)).toBe(false)
  })
})

describe('an extension\'s config', () => {
  const plugin = (name: string): BunPlugin => ({ name, setup: () => undefined })

  it('lies under the app\'s: objects merged key by key, arrays joined in the order listed, the app\'s value winning', () => {
    const config = mergeConfig({
      lang: 'fr',
      plugins: [plugin('app')],
      security: { csp: { 'img-src': ['https://app.example'] } },
      extensions: [
        { name: 'one', config: { lang: 'en', minify: false, plugins: [plugin('one')], security: { csp: { 'img-src': ['https://one.example'], 'font-src': ['https://fonts.example'] } } } },
        { name: 'two', config: { minify: true, plugins: [plugin('two')] } },
      ],
    }, {})

    expect(config.lang).toBe('fr')
    expect(config.minify).toBe(true)
    expect(config.plugins?.map(each => each.name)).toEqual(['one', 'two', 'app'])
    expect(config.security).toEqual({ csp: { 'img-src': ['https://one.example', 'https://app.example'], 'font-src': ['https://fonts.example'] } })
  })

  it('keeps a schema whole, and follows the extensions options given in code name', () => {
    const schema = t.Object({ MAP_KEY: t.String() })
    const config = mergeConfig({ publicEnv: schema, extensions: [{ name: 'file', config: { lang: 'de' } }] }, { extensions: [{ name: 'code', config: { lang: 'it', publicEnv: t.Object({ OTHER: t.String() }) } }] })

    expect(config.publicEnv).toBe(schema)
    expect(config.lang).toBe('it')
  })
})
