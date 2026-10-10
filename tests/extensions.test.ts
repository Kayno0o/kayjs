import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parse } from 'devalue'

const CLI = resolve('src/cli.ts')

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
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
  'src/routes/auth/register.kay': 'p.register mine\n',
  'kay.config.ts': 'import { defineConfig } from \'kay/server\'\nimport { authPages } from \'kay-lib\'\n\nexport default defineConfig({ extensions: [authPages()] })\n',
  'node_modules/kay-lib/package.json': JSON.stringify({ name: 'kay-lib', type: 'module', exports: { '.': './index.ts' }, peerDependencies: { kay: '*' } }),
  'node_modules/kay-lib/index.ts': 'import type { KayExtension } from \'kay/server\'\n\nexport const authPages = (): KayExtension => ({ name: \'kay-lib\', routes: { dir: `${import.meta.dir}/routes`, prefix: \'/auth\' } })\n',
  'node_modules/kay-lib/routes/_layout.kay': '---\nimport \'./lib.css\'\n---\nsection.lib\n  slot\n',
  'node_modules/kay-lib/routes/lib.css': '.lib { color: teal }\n',
  'node_modules/kay-lib/routes/register.kay': 'p.register theirs\n',
  'node_modules/kay-lib/routes/login.kay': LOGIN,
  'node_modules/kay-lib/counter.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton.count(type="button" onClick={() => n.set(n() + 1)}) {n()}\n',
}

// A process serves one project, so the app is served in its own, reporting what each page answered.
const SERVE = `import { stringify } from 'devalue'
import { pages } from 'kay/server'

const app = await pages({ root: import.meta.dir, prebuilt: true })
const visit = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()
const login = await visit('/auth/login')
const action = (/<form[^>]*action="([^"]+)"/).exec(login)?.[1] ?? ''
const posted = await app.handle(new Request(\`http://localhost\${action}\`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kay-action': '1' }, body: stringify({ name: 'Ada' }) }))

console.log(JSON.stringify({ login, action, posted: await posted.text(), register: await visit('/auth/register'), home: await visit('/') }))
process.exit(0)
`

let root: string

beforeAll(async () => {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, 'extension-'))
  await Promise.all(Object.entries({ ...FILES, 'serve.ts': SERVE }).map(async ([path, content]) => Bun.write(join(root, path), content)))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(...command: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn([process.execPath, ...command], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, stdout, stderr }
}

describe('a library\'s routes', () => {
  it('serve under their prefix inside the app\'s layouts, a library layout filling a level the app has none at, and an app page at the same path replacing the library\'s', async () => {
    const { code, stdout, stderr } = await run('serve.ts')

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    const { login, action, posted, register, home } = JSON.parse(stdout) as { login: string, action: string, posted: string, register: string, home: string }

    expect(login).toContain('<header class="app">App</header>')
    expect(login).toMatch(/<section class="lib">.*<form/s)
    // Its island hydrates, bundled with the app's.
    expect(login).toContain('data-component="node_modules/kay-lib/counter.kay"')
    expect(login).toMatch(/rel="modulepreload" href="\/_kay\/counter-/)
    // So does its layout's stylesheet.
    expect(login).toMatch(/rel="stylesheet" href="\/_kay\/_layout-[^"]+\.css"/)
    expect(register).toContain('<p class="register">mine</p>')
    expect(home).toContain('<p class="home">home</p>')
    expect(action).toBe('/_kay/action/node_modules/kay-lib/routes/login.kay/signIn')
    expect(parse(posted)).toEqual({ signedIn: 'Ada' })
  })

  it('are pages kay check lets a link point at', async () => {
    const { code, stdout, stderr } = await run(CLI, 'check')
    const output = `${stdout}${stderr}`

    expect(code).toBe(1)
    expect([...output.matchAll(/serves (\S+?)"/g)].map(match => match[1])).toEqual(['/auth/nope', '/auth/nope'])
  })
})
