import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { serverExtensions } from '../src/config'
import { kayCheck } from './check-helper'
import { scratchDir } from './scratch'

const CLI = resolve('src/cli.ts')
const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] })

// An app with no kay.config.ts and no src/server.ts: two plugins in src/plugins, the second reading what the first derives, a helper and a test the folder leaves out.
const APP: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app' }),
  'tsconfig.json': TSCONFIG,
  'src/plugins/10-who.ts': 'import { Elysia } from \'elysia\'\n\nexport default new Elysia({ name: \'who\' }).derive({ as: \'global\' }, () => ({ who: \'ada\' }))\n',
  'src/plugins/20-greet.ts': 'import { Elysia } from \'elysia\'\n\n// Reads what the plugin before it derived, so the order of the file names matters.\nexport default () => new Elysia({ name: \'greet\' }).get(\'/hello\', (context) => `hello ${(context as unknown as { who?: string }).who}`)\n',
  'src/plugins/_helper.ts': 'throw new Error(\'a helper is no plugin\')\n',
  'src/plugins/who.test.ts': 'throw new Error(\'a test is no plugin\')\n',
  'src/routes/index.kay': '--- server\nconst who: string = ctx.locals.who\n---\np {who}\n',
  'serve.ts': `import { pages } from 'kay/server'

const app = await pages({ prebuilt: true })
const get = async (path: string) => (await app.handle(new Request(\`http://localhost\${path}\`))).text()

console.log(JSON.stringify({ home: await get('/'), hello: await get('/hello') }))
process.exit(0)
`,
}

let root = ''

beforeAll(async () => {
  const base = join(import.meta.dir, '../node_modules/.cache')

  await mkdir(base, { recursive: true })
  root = await mkdtemp(join(base, 'server-plugins-'))
  await Promise.all(Object.entries(APP).map(async ([path, content]) => Bun.write(join(root, path), content)))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function run(command: string[], cwd: string): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, stdout, stderr }
}

describe('the app\'s src/plugins', () => {
  it('lists its modules by name, a helper or a test left out, before the config\'s extensions', () => {
    const own = { name: 'own' }

    expect(serverExtensions(root, [own]).map(({ name }) => name)).toEqual(['src/plugins/10-who.ts', 'src/plugins/20-greet.ts', 'own'])
    expect(serverExtensions(join(root, 'nothing'), undefined)).toEqual([])
  })

  it('are mounted before the pages with no config and no server entry, their locals read by a page', async () => {
    const { stdout, stderr, code } = await run([process.execPath, 'serve.ts'], root)

    expect(stderr).not.toContain('error')
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ home: expect.stringContaining('<p>ada</p>') as string, hello: 'hello ada' })
  })

  it('are carried by the executable, which mounts them with no src/plugins to read', async () => {
    const built = await run([process.execPath, CLI, 'build', '--no-check', '--compile', 'server', '--entry', 'serve.ts'], root)

    expect(built.stderr).not.toContain('error')
    expect(built.code).toBe(0)
    const elsewhere = join(root, '..', `${basename(root)}-elsewhere`)

    await mkdir(elsewhere, { recursive: true })

    try {
      const served = await run([join(root, 'server')], elsewhere)

      expect(served.code).toBe(0)
      expect(JSON.parse(served.stdout)).toEqual({ home: expect.stringContaining('<p>ada</p>') as string, hello: 'hello ada' })
    }
    finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  }, 60_000)

  it('type ctx.locals for kay check', async () => {
    const typed = await scratchDir('server-plugins-typed-')

    await Promise.all(Object.entries({ ...APP, 'src/routes/index.kay': '--- server\nconst who: number = ctx.locals.who\n---\np {who}\n' }).map(async ([path, content]) => Bun.write(join(typed, path), content)))

    const { code, output, report } = await kayCheck([typed])

    expect(`${report}${output}`).toMatch(/Type 'string' is not assignable to type 'number'/)
    expect(code).toBe(1)
  })
})
