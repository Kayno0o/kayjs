import { realpathSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { appModules, declaredAppFiles, extensionAppFiles, extensionServers } from '../src/config'
import { scratchDir } from './scratch'

const CLI = resolve('src/cli.ts')
const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] })

// An extension of the app's own config naming two optional files, and answering with what it found in them and the root it was given.
const CONFIG = `import { Elysia } from 'elysia'
import { defineConfig } from 'kay/server'

export default defineConfig({
  extensions: [{
    name: 'probe',
    appFiles: { hooks: 'src/probe.ts', mail: 'src/probe-mail.ts' },
    server: ({ root, modules, extensions }) => new Elysia().get('/probe', () => JSON.stringify({ hooks: modules.hooks?.word ?? null, mail: modules.mail?.word ?? null, root, extensions })),
  }],
})
`

const SERVE = `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const get = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()

console.log(JSON.stringify({ probe: await get('/probe') }))
process.exit(0)
`

function app(files: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'app' }),
    'tsconfig.json': TSCONFIG,
    'kay.config.ts': CONFIG,
    'src/routes/index.kay': 'p home\n',
    'serve.ts': SERVE,
    ...files,
  }
}

async function written(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('app-files-')

  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function run(command: string[], cwd: string, env: Record<string, string> = {}): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, stdout, stderr }
}

// What the probe route answered, as an object.
function probed(stdout: string): Record<string, unknown> {
  return JSON.parse((JSON.parse(stdout) as { probe: string }).probe) as Record<string, unknown>
}

describe('the files an extension names in appFiles', () => {
  it('are imported when the app has them and undefined when it has not, each by its name', async () => {
    const root = await written({ 'src/hooks.ts': 'export const word = \'one\'\n' })

    try {
      const extension = { name: 'probe', appFiles: { hooks: 'src/hooks.ts', mail: 'src/mail.ts', folder: 'src' } }
      const modules = await appModules(root, extension)

      expect(modules.hooks?.word).toBe('one')
      expect(modules.mail).toBeUndefined()
      // A folder is no file.
      expect(modules.folder).toBeUndefined()
      expect(extensionAppFiles(root, [extension])).toEqual([join(root, 'src/hooks.ts')])
      expect(declaredAppFiles(root, [extension])).toHaveLength(3)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('are handed to a server function with the root, and the function is built again for each boot', async () => {
    const root = await written({ 'src/hooks.ts': 'export const word = \'one\'\n' })

    try {
      const seen: unknown[] = []
      const extension = { name: 'probe', appFiles: { hooks: 'src/hooks.ts' }, server: (given: unknown) => {
        seen.push(given)

        return {} as never
      } }

      await extensionServers([extension], root)
      await extensionServers([extension], root)
      expect(seen).toHaveLength(2)
      expect(seen[0]).toMatchObject({ root, modules: { hooks: { word: 'one' } }, extensions: ['probe'] })
      expect(seen[0]).not.toBe(seen[1])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuse a path outside the project root, however it is written', async () => {
    const root = await written({})

    try {
      for (const path of ['../outside.ts', 'src/../../outside.ts', '/etc/passwd', '..', '.', ''])
        await expect(appModules(root, { name: 'evil', appFiles: { file: path } })).rejects.toThrow('is not under the project root')

      expect(() => declaredAppFiles(root, [{ name: 'evil', appFiles: { file: '../outside.ts' } }])).toThrow('evil')
      // A file whose name merely starts with two dots is inside.
      await expect(appModules(root, { name: 'fine', appFiles: { file: '..hidden.ts' } })).resolves.toEqual({ file: undefined })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reach the server in production, found under the root the process runs from, with the file present or absent', async () => {
    const present = await written(app({ 'src/probe.ts': 'export const word = \'hooked\'\n', 'src/probe-mail.ts': 'export const word = \'mailed\'\n' }))
    const absent = await written(app())

    try {
      const withFiles = await run([process.execPath, 'serve.ts'], present, { KAY_ROOT: present })
      const without = await run([process.execPath, 'serve.ts'], absent, { KAY_ROOT: absent })

      expect(withFiles.stderr).not.toContain('error')
      expect(probed(withFiles.stdout)).toEqual({ hooks: 'hooked', mail: 'mailed', root: present, extensions: ['probe'] })
      expect(probed(without.stdout)).toEqual({ hooks: null, mail: null, root: absent, extensions: ['probe'] })
    }
    finally {
      await Promise.all([rm(present, { recursive: true, force: true }), rm(absent, { recursive: true, force: true })])
    }
  }, 60_000)

  it('are carried by an executable that finds them with no src folder beside it, and one built without them runs with none', async () => {
    const present = await written(app({ 'src/probe.ts': 'export const word = \'hooked\'\n' }))
    const absent = await written(app())
    const elsewhere = await scratchDir('app-files-elsewhere-')

    try {
      for (const root of [present, absent]) {
        const built = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root)

        expect(built.stderr).not.toContain('error')
        expect(built.code).toBe(0)
      }

      await mkdir(elsewhere, { recursive: true })

      const withFile = await run([join(present, 'server')], elsewhere)
      const without = await run([join(absent, 'server')], elsewhere)

      expect(withFile.code).toBe(0)
      // The data the extension keeps lives where the executable runs, not where it was built.
      expect(probed(withFile.stdout)).toEqual({ hooks: 'hooked', mail: null, root: realpathSync(elsewhere), extensions: ['probe'] })
      expect(probed(without.stdout)).toEqual({ hooks: null, mail: null, root: realpathSync(elsewhere), extensions: ['probe'] })
    }
    finally {
      await Promise.all([present, absent, elsewhere].map(async dir => rm(dir, { recursive: true, force: true })))
    }
  }, 180_000)
})

// An app listing auth() beside mail(), with a probe route registering a user and answering the mails kayjs-mail kept.
function AUTH_CONFIG(withMail: boolean) {
  return `import { auth } from '@kaynooo/kayjs-auth'
import { mail, outbox } from '@kaynooo/kayjs-mail'
import { Elysia } from 'elysia'
import { defineConfig } from 'kay/server'
import { mail as mailer } from './src/mail'

export default defineConfig({
  site: 'http://localhost',
  extensions: [
    auth({ viewer: false, captcha: false }),
    ${withMail ? 'mail({ module: \'./src/mail\' }),' : ''}
    { name: 'probe', server: () => new Elysia().post('/probe', async (ctx) => {
      await (ctx as unknown as { auth: { register: (input: unknown) => Promise<unknown> } }).auth.register({ email: 'ada@example.com', password: 'correct horse battery' })
      for (let wait = 0; wait < 100 && outbox.mails.length === 0; wait++) {
        await mailer.drain()
        await Bun.sleep(50)
      }

      return JSON.stringify(outbox.mails.map(sent => ({ subject: sent.subject, styled: sent.html?.includes('<table') ?? false })))
    }) },
  ],
})
`
}

const AUTH_SERVE = `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const answer = await (await app.handle(new Request('http://localhost/probe', { method: 'POST', headers: { origin: 'http://localhost' } }))).text()

console.log(JSON.stringify({ probe: answer }))
process.exit(0)
`

describe('auth() beside mail()', () => {
  it('sends the auth mails in kayjs-mail\'s wording from an executable, which has no kay.config.ts beside it, as kay dev does', async () => {
    const files = (withMail: boolean) => app({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@iconify-json/tabler': '*' } }),
      'kay.config.ts': AUTH_CONFIG(withMail),
      'serve.ts': AUTH_SERVE,
      'src/mail.ts': 'import { mailer, outbox } from \'@kaynooo/kayjs-mail\'\n\nexport const mail = mailer({ from: \'site@localhost\', transport: outbox })\n',
    })

    const [listed, unlisted, elsewhere, other] = await Promise.all([written(files(true)), written(files(false)), scratchDir('app-files-elsewhere-'), scratchDir('app-files-other-')])

    try {
      const answers: unknown[] = []

      // Each executable runs in a folder of its own, as each opens its own data/auth.db.
      for (const [root, cwd] of [[listed, elsewhere], [unlisted, other]] as const) {
        const built = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root)

        expect(built.stderr).not.toContain('error')
        expect(built.code).toBe(0)

        const ran = await run([join(root, 'server')], cwd, { KAY_SECRET: 'a-secret-long-enough-for-a-kay-session-cookie' })

        expect(ran.code).toBe(0)
        answers.push(JSON.parse((JSON.parse(ran.stdout) as { probe: string }).probe))
      }

      // Themed html comes from kayjs-mail's views, which an executable finds by the extension listed and not by reading kay.config.ts; with no mail() listed the bare mailer sends kayjs-auth's own.
      expect(answers).toEqual([[{ subject: 'Confirm your email for localhost', styled: true }], [{ subject: 'Confirm your email for localhost', styled: false }]])
    }
    finally {
      await Promise.all([listed, unlisted, elsewhere, other].map(async dir => rm(dir, { recursive: true, force: true })))
    }
  }, 240_000)
})
