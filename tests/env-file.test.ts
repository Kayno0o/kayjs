import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { compareEnv } from '../src/commands/env-compare'
import { s } from '../src/runtime/schema'
import { defineEnv } from '../src/server'
import { describeEnv } from '../src/server/env'
import { scratchDir } from './scratch'

const dirs: string[] = []

async function folder(files: Record<string, string> = {}): Promise<string> {
  const dir = await scratchDir('env-file-')

  dirs.push(dir)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(dir, path), content)))

  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

const schema = s.Object({ API_KEY: s.String(), TOKEN: s.Secret(), MODE: s.String({ default: 'fast' }), NOTE: s.Optional(s.String()), PORT: s.Integer({ default: 3000 }) })

describe('a defineEnv string read from <NAME>_FILE', () => {
  it('takes the file\'s content, a trailing newline trimmed and the rest kept', async () => {
    const dir = await folder({ key: 'abc def\n', crlf: 'secret\r\n', token: `${'t'.repeat(32)}\n\n` })
    const env = defineEnv(schema, { API_KEY_FILE: join(dir, 'key'), TOKEN_FILE: join(dir, 'token'), NODE_ENV: 'production' })

    expect(env.API_KEY).toBe('abc def')
    expect(env.TOKEN).toBe('t'.repeat(32))
    expect(defineEnv(s.Object({ A: s.String() }), { A_FILE: join(dir, 'crlf') }).A).toBe('secret')
  })

  it('reads the file once, as the server boots', async () => {
    const dir = await folder({ key: 'first' })
    const env = defineEnv(s.Object({ A: s.String() }), { A_FILE: join(dir, 'key') })

    await Bun.write(join(dir, 'key'), 'second')
    expect(env.A).toBe('first')
  })

  it('serves a variable that is optional, defaulted or required in production', async () => {
    const dir = await folder({ key: 'from file' })
    const source = { MODE_FILE: join(dir, 'key'), NOTE_FILE: join(dir, 'key'), NODE_ENV: 'production', API_KEY: 'x', TOKEN: 'y'.repeat(32) }

    expect(defineEnv(schema, source)).toMatchObject({ MODE: 'from file', NOTE: 'from file' })
  })

  it('lets the variable win nothing: both set fails, naming both', async () => {
    const dir = await folder({ key: 'abc' })

    expect(() => defineEnv(s.Object({ API_KEY: s.String() }), { API_KEY: 'direct', API_KEY_FILE: join(dir, 'key') })).toThrow(/API_KEY and API_KEY_FILE/)
  })

  it('counts an empty variable as unset, so its file applies', async () => {
    const dir = await folder({ key: 'abc' })

    expect(defineEnv(s.Object({ API_KEY: s.String() }), { API_KEY: '', API_KEY_FILE: join(dir, 'key') }).API_KEY).toBe('abc')
    expect(defineEnv(s.Object({ API_KEY: s.String({ default: 'dflt' }) }), { API_KEY_FILE: '' }).API_KEY).toBe('dflt')
  })

  it('fails at boot, naming the variable and the path, for a missing file', async () => {
    const dir = await folder()
    const path = join(dir, 'absent')

    expect(() => defineEnv(s.Object({ API_KEY: s.String() }), { API_KEY_FILE: path })).toThrow(`API_KEY_FILE ${path}`)
    expect(() => defineEnv(s.Object({ API_KEY: s.Optional(s.String()) }), { API_KEY_FILE: path })).toThrow('API_KEY_FILE')
  })

  it('fails at boot for a file that cannot be read, a folder or one with no permission', async () => {
    const dir = await folder({ 'locked': 'secret', 'sub/file': 'x' })

    await chmod(join(dir, 'locked'), 0o000)

    expect(() => defineEnv(s.Object({ A: s.String() }), { A_FILE: join(dir, 'sub') })).toThrow('A_FILE')

    // A user that may read anything, root in a container, reads a file whatever its mode.
    if (process.getuid?.() !== 0)
      expect(() => defineEnv(s.Object({ A: s.String() }), { A_FILE: join(dir, 'locked') })).toThrow('A_FILE')
  })

  it('fails for an empty file, so a secret never falls back to its default', async () => {
    const dir = await folder({ empty: '', blank: ' \n' })

    expect(() => defineEnv(s.Object({ A: s.String({ default: 'dflt' }) }), { A_FILE: join(dir, 'empty') })).toThrow('A_FILE')
    expect(() => defineEnv(s.Object({ A: s.String() }), { A_FILE: join(dir, 'blank') })).toThrow('is empty')
  })

  it('never puts the value in an error', async () => {
    const dir = await folder({ key: 'hunter2-hunter2-hunter2-hunter2' })

    try {
      defineEnv(s.Object({ A: s.String({ pattern: '^[0-9]+$' }) }), { A_FILE: join(dir, 'key') })
      expect.unreachable()
    }
    catch (error) {
      expect(String((error as Error).message)).not.toContain('hunter2')
    }
  })

  it('checks the value against the schema as any other', async () => {
    const dir = await folder({ key: 'short' })

    expect(() => defineEnv(s.Object({ A: s.String({ minLength: 10 }) }), { A_FILE: join(dir, 'key') })).toThrow(/A: /)
  })

  it('leaves a number, a public field and a name the app declares itself alone', async () => {
    const dir = await folder({ key: '42' })
    const path = join(dir, 'key')

    expect(defineEnv(s.Object({ PORT: s.Integer({ default: 3000 }) }), { PORT_FILE: path }).PORT).toBe(3000)
    expect(defineEnv(s.Object({ MAP: s.Optional(s.Public(s.String())) }), { MAP_FILE: path }).MAP).toBeUndefined()
    // `AURORA_KEY_FILE` declared by hand stays the app's: nothing reads the file, and nothing refuses both.
    expect(defineEnv(s.Object({ AURORA_KEY: s.Optional(s.String()), AURORA_KEY_FILE: s.Optional(s.String()) }), { AURORA_KEY: 'x', AURORA_KEY_FILE: path })).toEqual({ AURORA_KEY: 'x', AURORA_KEY_FILE: path })
  })

  it('keeps the placeholder of development and tests for a secret neither the variable nor a file gives', async () => {
    const dir = await folder({ token: 'z'.repeat(40) })

    expect(defineEnv(s.Object({ TOKEN: s.Secret() }), { NODE_ENV: 'test', TOKEN_FILE: join(dir, 'token') }).TOKEN).toBe('z'.repeat(40))
    expect(defineEnv(s.Object({ TOKEN: s.Secret() }), { NODE_ENV: 'test' }).TOKEN.length).toBeGreaterThanOrEqual(32)
  })

  it('is left unread by a build that runs without the server\'s environment', async () => {
    const BUILDING = Symbol.for('kay.building')
    const global = globalThis as Record<symbol, unknown>
    const dir = await folder()

    global[BUILDING] = true

    try {
      const env = defineEnv(s.Object({ A: s.String() }), { A_FILE: join(dir, 'absent') })

      expect(() => env.A).toThrow('A')
    }
    finally {
      delete global[BUILDING]
    }
  })
})

describe('kay env and kay check with the file form', () => {
  const variables = describeEnv(schema).map(variable => ({ ...variable, source: 'src/env.ts' }))

  it('counts <NAME>_FILE in a compose file or the example as setting the variable', async () => {
    const root = await folder({
      'compose.yaml': 'services:\n  app:\n    environment:\n      API_KEY_FILE: /run/secrets/key\n      TOKEN_FILE: /run/secrets/token\n',
      '.env.example': 'API_KEY_FILE=\nTOKEN_FILE=\n',
    })

    expect(await compareEnv(root, variables, { compose: 'compose.yaml', example: '.env.example' })).toEqual([])
  })

  it('still asks for a variable neither the variable nor its file sets', async () => {
    const root = await folder({ 'compose.yaml': 'services:\n  app:\n    environment:\n      MODE: slow\n' })
    const messages = (await compareEnv(root, variables, { compose: 'compose.yaml' })).map(({ message }) => message)

    expect(messages).toEqual([expect.stringContaining('API_KEY is required'), expect.stringContaining('TOKEN is required')])
  })

  it('does not call a file variable undeclared, or a raw read of it', async () => {
    const root = await folder({ '.env.example': 'API_KEY_FILE=\nTOKEN_FILE=\n', 'src/reader.ts': 'export const path = process.env.API_KEY_FILE\n' })

    expect(await compareEnv(root, variables, { example: '.env.example' })).toEqual([])
  })

  it('does not mistake the file form of a number or a name the app declares', async () => {
    const root = await folder({ '.env.example': 'PORT_FILE=\n' })
    const messages = (await compareEnv(root, variables, { example: '.env.example' })).map(({ message }) => message)

    expect(messages).toContain('PORT_FILE is in .env.example and no schema declares it')
  })

  it('says in the listing that a string reads its file', async () => {
    const dir = await folder()

    await mkdir(join(dir, 'src'))
    await Bun.write(join(dir, 'kay.config.ts'), 'export default { favicon: false }\n')
    await Bun.write(join(dir, 'src/env.ts'), 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ API_KEY: s.String() }))\n')

    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'env'], { cwd: dir, env: { PATH: process.env.PATH! }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited])

    expect(stdout).toContain('API_KEY')
    expect(stdout).toContain('<NAME>_FILE')
  })
})
