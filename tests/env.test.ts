import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { t } from 'elysia'
import { s } from '../src/runtime/schema'
import { defineEnv } from '../src/server'
import { overrideEnv } from '../src/test'
import { scratchDir } from './scratch'

// Many cases spawn the CLI, which a loaded host runs slowly.
setDefaultTimeout(30_000)

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []

const secrets = t.Object({
  SESSION_SECRET: t.String({ default: 'dev-secret', requiredInProduction: true }),
  SMTP_HOST: t.Optional(t.String({ requiredInProduction: true })),
  PORT: t.Integer({ default: 3000 }),
})

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('env-')

  dirs.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

async function kay(args: string[], cwd: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { PATH: process.env.PATH!, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('a variable required in production only', () => {
  it('takes its default or stays out in development and tests, and a bare environment boots', () => {
    expect(defineEnv(secrets, {})).toEqual({ SESSION_SECRET: 'dev-secret', PORT: 3000 })
    expect(defineEnv(secrets, { NODE_ENV: 'development' })).toEqual({ SESSION_SECRET: 'dev-secret', PORT: 3000 })
    expect(defineEnv(secrets, { NODE_ENV: 'test' })).toEqual({ SESSION_SECRET: 'dev-secret', PORT: 3000 })
    expect(defineEnv(secrets, { SESSION_SECRET: 'real', SMTP_HOST: 'mx' })).toEqual({ SESSION_SECRET: 'real', SMTP_HOST: 'mx', PORT: 3000 })
  })

  it('is refused at boot in production, its default dropped, each missing one named', () => {
    expect(() => defineEnv(secrets, { NODE_ENV: 'production' })).toThrow(/SESSION_SECRET: .*\n.*SMTP_HOST: /)
    expect(() => defineEnv(secrets, { NODE_ENV: 'production', SESSION_SECRET: 'real' })).toThrow('SMTP_HOST')
    expect(() => defineEnv(secrets, { NODE_ENV: 'production', SESSION_SECRET: '', SMTP_HOST: 'mx' })).toThrow('SESSION_SECRET')
    expect(defineEnv(secrets, { NODE_ENV: 'production', SESSION_SECRET: 'real', SMTP_HOST: 'mx' })).toEqual({ SESSION_SECRET: 'real', SMTP_HOST: 'mx', PORT: 3000 })
  })

  it('leaves the schema it was given as it was', () => {
    expect(() => defineEnv(secrets, { NODE_ENV: 'production' })).toThrow()
    expect(defineEnv(secrets, {}).SESSION_SECRET).toBe('dev-secret')
  })
})

describe('s.Secret and a required-in-production string with no default', () => {
  const secret = s.Object({ SESSION_SECRET: s.Secret(), HOST_NAME: s.String({ requiredInProduction: true, pattern: '^[a-z]+$' }), SMTP: s.Optional(s.String({ requiredInProduction: true })) })

  it('is derived in development and tests, the same twice, and as long as a secret', () => {
    const first = defineEnv(secret, { NODE_ENV: 'development' })
    const typed: string = first.SESSION_SECRET

    expect(typed.length).toBeGreaterThanOrEqual(32)
    expect(defineEnv(secret, { NODE_ENV: 'test' }).SESSION_SECRET).toBe(typed)
    expect(first.HOST_NAME).toBe('')
    expect(first.SMTP).toBeUndefined()
    expect(defineEnv(s.Object({ OTHER: s.Secret() }), { NODE_ENV: 'test' }).OTHER).not.toBe(typed)
  })

  it('differs between project paths', async () => {
    const run = async (cwd: string) => (await Bun.$`bun -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; console.log(defineEnv(s.Object({ A: s.Secret() }), { NODE_ENV: 'test' }).A)`}`.cwd(cwd).quiet().text()).trim()
    const a = await project({ 'a.txt': '' })
    const b = await project({ 'a.txt': '' })

    expect(await run(a)).toBe(await run(a))
    expect(await run(a)).not.toBe(await run(b))
  })

  it('mixes in a random seed kept in the checkout\'s .kay, so the same path elsewhere gives another value', async () => {
    const run = async (cwd: string) => (await Bun.$`bun -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; console.log(defineEnv(s.Object({ A: s.Secret() }), { NODE_ENV: 'test' }).A)`}`.cwd(cwd).quiet().text()).trim()
    const root = await project({ 'a.txt': '' })
    const first = await run(root)

    expect(await run(root)).toBe(first)
    expect(((await stat(join(root, '.kay/dev-secret'))).mode & 0o777)).toBe(0o600)
    await rm(join(root, '.kay/dev-secret'))
    expect(await run(root)).not.toBe(first)
  })

  it('is derived only under development and test: any other NODE_ENV, or none, refuses a missing secret', () => {
    expect(() => defineEnv(secret, {})).toThrow('SESSION_SECRET')
    expect(() => defineEnv(secret, { HOST: '0.0.0.0' })).toThrow('SESSION_SECRET')
    expect(() => defineEnv(secret, { NODE_ENV: 'staging' })).toThrow('SESSION_SECRET')
    expect(defineEnv(secret, { NODE_ENV: 'staging', SESSION_SECRET: 'x'.repeat(40) }).SESSION_SECRET).toBe('x'.repeat(40))
    expect(defineEnv(secret, { NODE_ENV: 'development' }).SESSION_SECRET).toHaveLength(64)
  })

  it('writes the seed again when its file is empty or cut short, and fails clearly when .kay cannot be written', async () => {
    const run = async (cwd: string) => Bun.$`bun -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; try { console.log(defineEnv(s.Object({ A: s.Secret() }), { NODE_ENV: 'test' }).A) } catch (error) { console.log(error.message) }`}`.cwd(cwd).quiet().text()
    const root = await project({ '.kay/dev-secret': 'short' })
    const first = (await run(root)).trim()

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect((await Bun.file(join(root, '.kay/dev-secret')).text()).length).toBeGreaterThanOrEqual(64)
    expect((await run(root)).trim()).toBe(first)

    const blocked = await project({ '.kay': 'a file, not a folder' })

    expect(await run(blocked)).toContain('the development secret cannot be kept in')
  })

  it('keeps 32 characters whatever minLength is given', () => {
    expect(s.Secret({ minLength: 8 }).minLength).toBe(32)
    expect(s.Secret({ minLength: 64 }).minLength).toBe(64)
  })

  it('takes a set value, an empty one counting as unset, and refuses a short one', () => {
    const long = 'x'.repeat(40)

    expect(defineEnv(secret, { NODE_ENV: 'test', SESSION_SECRET: long, HOST_NAME: 'abc' })).toMatchObject({ SESSION_SECRET: long, HOST_NAME: 'abc' })
    expect(defineEnv(secret, { NODE_ENV: 'test', SESSION_SECRET: '' }).SESSION_SECRET).toHaveLength(64)
    expect(() => defineEnv(secret, { NODE_ENV: 'test', SESSION_SECRET: 'short' })).toThrow('SESSION_SECRET')
    expect(() => defineEnv(secret, { NODE_ENV: 'test', HOST_NAME: 'A1' })).toThrow('HOST_NAME')
  })

  it('never uses the derived value in production', () => {
    const dev = defineEnv(secret, { NODE_ENV: 'test' }).SESSION_SECRET

    expect(() => defineEnv(secret, { NODE_ENV: 'production' })).toThrow(/SESSION_SECRET: .*\n.*HOST_NAME: .*\n.*SMTP: /)
    expect(() => defineEnv(secret, { NODE_ENV: 'production', SESSION_SECRET: 'short', HOST_NAME: 'a', SMTP: 'x' })).toThrow('SESSION_SECRET')
    expect(defineEnv(secret, { NODE_ENV: 'production', SESSION_SECRET: `${dev}z`, HOST_NAME: 'a', SMTP: 'x' }).SESSION_SECRET).toBe(`${dev}z`)
  })

  it('still works with overrideEnv', () => {
    const env = defineEnv(secret, { NODE_ENV: 'test' })

    using override = overrideEnv(env, { SESSION_SECRET: 'y'.repeat(32) })

    expect(env.SESSION_SECRET).toBe('y'.repeat(32))
    expect(override).toBeDefined()
  })
})

describe('kay env', () => {
  const files = {
    'kay.config.ts': 'import { Elysia, t } from \'elysia\'\n\nconst lib = { name: \'lib\', env: t.Object({ LIB_KEY: t.String({ description: \'the library\\\'s key\', requiredInProduction: true }), LIB_MODE: t.String({ default: \'fast\' }) }) }\n\nexport default { favicon: false, extensions: [lib], publicEnv: t.Object({ MAP_KEY: t.Numeric({ default: 1 }), SITE: t.Optional(t.String({ format: \'uri\' })) }) }\n',
    'src/server.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nthrow new Error(\'the entry must not run\')\nexport const env = defineEnv(s.Object({ ENTRY_ONLY: s.String() }))\n',
    'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nconsole.log(\'loading the env\')\n\nexport const env = defineEnv(s.Object({\n  DATABASE_URL: s.String(),\n  SESSION_SECRET: s.String({ default: \'dev\', requiredInProduction: true }),\n  PORT: s.Integer({ default: 8080 }),\n  DEBUG: s.Optional(s.Boolean()),\n}))\n',
    'src/broken.ts': 'import { defineEnv } from \'kay/server\'\nimport \'./missing\'\n\nexport const env = defineEnv({} as never)\n',
  }

  it('marks s.Secret as a secret required in production, with kay env and kay build run without it', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ SESSION_SECRET: s.Secret(), CLIENT_ID: s.String({ requiredInProduction: true }) }))\n',
    })
    const { stdout, code } = await kay(['env', '--format', 'json'], root)
    const rows = (JSON.parse(stdout) as { variables: Record<string, unknown>[] }).variables

    expect(code).toBe(0)
    expect(rows.find(row => row.name === 'SESSION_SECRET')).toEqual({ name: 'SESSION_SECRET', source: 'src/env.ts', type: 'string', required: 'production', secret: true })
    expect(rows.find(row => row.name === 'CLIENT_ID')).toEqual({ name: 'CLIENT_ID', source: 'src/env.ts', type: 'string', required: 'production' })
    expect((await kay(['env'], root)).stdout).toContain('SESSION_SECRET  src/env.ts  string (secret)  production')
  })

  it('builds with no value for an s.Secret, kay env and kay check listing it without throwing', async () => {
    const root = await project({
      'tsconfig.json': '{ "extends": "kay/tsconfig.json" }\n',
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ SESSION_SECRET: s.Secret() }))\n',
      'src/routes/index.kay': '---\nimport { env } from \'../env\'\n---\np {String(env === undefined)}\n',
    })
    const built = Bun.spawn([process.execPath, cli, 'build', root, '--no-check'], { stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH! } })

    expect(await built.exited, await new Response(built.stderr).text()).toBe(0)
  })

  it('lists the variables of the app\'s schemas and of the extensions\', and kay\'s own, with whether each is required and its default, without the environment', async () => {
    const root = await project(files)
    const { stdout, stderr, code } = await kay(['env', '--format', 'json'], root)

    expect(code, stderr).toBe(0)
    expect(stdout.trimEnd().split('\n')).toHaveLength(1)
    expect(stderr).toBe('loading the env\n')

    const listed = JSON.parse(stdout) as { variables: { name: string, source: string, type: string, required: string | false, default?: unknown, description?: string }[], unread: { file: string, error: string }[] }
    const row = (name: string) => listed.variables.find(variable => variable.name === name)

    expect(row('DATABASE_URL')).toEqual({ name: 'DATABASE_URL', source: 'src/env.ts', type: 'string', required: 'always' })
    expect(row('SESSION_SECRET')).toEqual({ name: 'SESSION_SECRET', source: 'src/env.ts', type: 'string', required: 'production', default: 'dev' })
    expect(row('PORT')).toEqual({ name: 'PORT', source: 'src/env.ts', type: 'integer', required: false, default: 8080 })
    expect(row('DEBUG')).toEqual({ name: 'DEBUG', source: 'src/env.ts', type: 'boolean', required: false })
    expect(row('LIB_KEY')).toEqual({ name: 'LIB_KEY', source: 'the extension lib', type: 'string', required: 'production', description: 'the library\'s key' })
    expect(row('LIB_MODE')).toEqual({ name: 'LIB_MODE', source: 'the extension lib', type: 'string', required: false, default: 'fast' })
    expect(row('MAP_KEY')).toEqual({ name: 'MAP_KEY', source: 'publicEnv in kay.config.ts', type: 'number', required: false, default: 1 })
    expect(row('SITE')).toEqual({ name: 'SITE', source: 'publicEnv in kay.config.ts', type: 'string (uri)', required: false })
    expect(row('ENTRY_ONLY')).toBeUndefined()
    expect(listed.variables.filter(variable => variable.source === 'kay').map(variable => variable.name)).toEqual(['PORT', 'HOST', 'SITE_URL', 'ORIGIN', 'KAY_SECRET'])
    expect(listed.unread.map(({ file }) => file)).toEqual(['src/broken.ts'])
    expect(listed.unread[0]!.error).toContain('missing')
  })

  it('prints a listing in text, and answers a bad format', async () => {
    const root = await project(files)
    const { stdout, code } = await kay(['env'], root)
    const lines = stdout.split('\n').map(line => line.trim().replaceAll(/ {2,}/g, ' | '))

    expect(code).toBe(0)
    expect(lines).toContain('SESSION_SECRET | src/env.ts | string | production | "dev"')
    expect(lines).toContain('DATABASE_URL | src/env.ts | string | always')
    expect(lines).toContain('LIB_KEY | the extension lib | string | production | # the library\'s key')
    expect(lines.some(line => line.startsWith('Not read: src/broken.ts ('))).toBe(true)
    expect((await kay(['env', '--format', 'xml'], root)).stderr).toBe('kay env: --format takes `text`, `json`, not `xml`\n')
  })

  it('lists a mailer built at import time once, under the module that builds it and as the mailer is set up, and finds a caller whose path says defineEnv', async () => {
    const root = await project({
      'kay.config.ts': 'import { mailExtension } from \'@kaynooo/kayjs-mail\'\n\nexport default { favicon: false, extensions: [mailExtension(\'./src/defineEnv-mail/mail.ts\')] }\n',
      'src/defineEnv-mail/mail.ts': 'import { mailer } from \'@kaynooo/kayjs-mail\'\nimport { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ OWN: s.String() }))\nexport const mail = mailer({ optional: true })\n',
    })
    const { stdout, stderr, code } = await kay(['env', '--format', 'json'], root)

    expect(code, stderr).toBe(0)

    const listed = JSON.parse(stdout) as { variables: { name: string, source: string, required: string | false }[] }
    const rows = (name: string) => listed.variables.filter(variable => variable.name === name)

    expect(rows('OWN')).toEqual([expect.objectContaining({ source: 'src/defineEnv-mail/mail.ts' })])
    expect(rows('SMTP_HOST')).toEqual([expect.objectContaining({ source: 'src/defineEnv-mail/mail.ts', required: false })])
    expect(rows('SMTP_PORT')).toHaveLength(1)
  })
})

describe('a compiled server', () => {
  it('refuses a variable required in production only, and boots with it set', async () => {
    const root = await project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/routes/index.kay': 'p Home\n',
      'src/server.ts': 'import process from \'node:process\'\nimport { Elysia } from \'elysia\'\nimport { defineEnv, pages } from \'kay/server\'\nimport { s } from \'kay\'\n\nconst env = defineEnv(s.Object({ SESSION_SECRET: s.String({ default: \'dev\', requiredInProduction: true }) }))\nawait new Elysia().use(await pages({ security: false })).handle(new Request(\'http://localhost/\'))\nconsole.log(env.SESSION_SECRET)\nprocess.exit(0)\n',
    })
    const built = Bun.spawn([process.execPath, cli, 'build', root, '--compile', join(root, 'server'), '--no-check'], { stdout: 'pipe', stderr: 'pipe' })

    expect(await built.exited, await new Response(built.stderr).text()).toBe(0)

    const run = async (env: Record<string, string>) => {
      const child = Bun.spawn([join(root, 'server')], { cwd: root, env: { PATH: process.env.PATH!, ...env }, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      return { stdout, stderr, code }
    }
    const missing = await run({ NODE_ENV: 'production' })
    const set = await run({ NODE_ENV: 'production', SESSION_SECRET: 'real' })

    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('SESSION_SECRET')
    expect(set.stdout.trim()).toBe('real')
    expect(set.code).toBe(0)
  }, 90_000)
})

function readerEnv() {
  const env = defineEnv(t.Object({
    MEDIA_DIR: t.String({ default: 'media' }),
    DEBUG: t.Optional(t.Boolean()),
  }), { DEBUG: 'true' })

  return { env, mediaDir: (): string => env.MEDIA_DIR }
}

describe('overrideEnv', () => {
  it('gives a variable of an env already read another value for one test, and puts it back', async () => {
    const { env, mediaDir } = readerEnv()

    const override = overrideEnv(env, { MEDIA_DIR: '/tmp/a' })

    expect(mediaDir()).toBe('/tmp/a')
    override.restore()
    expect(mediaDir()).toBe('media')
    override.restore()
    expect(mediaDir()).toBe('media')
  })

  it('restores at the end of a using block, a failing one included', async () => {
    const { env, mediaDir } = readerEnv()

    expect(() => {
      using override = overrideEnv(env, { MEDIA_DIR: '/tmp/b' })

      expect(override).toBeDefined()
      expect(mediaDir()).toBe('/tmp/b')

      throw new Error('a failing test')
    }).toThrow('a failing test')
    expect(mediaDir()).toBe('media')
  })

  it('nests, each restore putting back what its override replaced', async () => {
    const { env, mediaDir } = readerEnv()
    const outer = overrideEnv(env, { MEDIA_DIR: '/outer' })
    const inner = overrideEnv(env, { MEDIA_DIR: '/inner' })

    expect(mediaDir()).toBe('/inner')
    inner.restore()
    expect(mediaDir()).toBe('/outer')
    outer.restore()
    expect(mediaDir()).toBe('media')
  })

  it('unsets an optional variable with undefined and brings it back', async () => {
    const { env } = readerEnv()
    const override = overrideEnv(env, { DEBUG: undefined })

    expect('DEBUG' in env).toBe(false)
    override.restore()
    expect(env.DEBUG).toBe(true)
  })

  it('sets a variable the env did not hold and removes it after', async () => {
    const { env } = readerEnv()
    const other: { EXTRA?: string } = {}
    const override = overrideEnv(other, { EXTRA: 'x' })

    expect(other.EXTRA).toBe('x')
    override.restore()
    expect('EXTRA' in other).toBe(false)
    expect(env.MEDIA_DIR).toBe('media')
  })

  it('treats a hostile name as a plain variable, never reaching the prototype', () => {
    const env: Record<string, unknown> = {}
    const override = overrideEnv(env, JSON.parse('{"__proto__":{"polluted":true},"constructor":"x"}') as Record<string, unknown>)

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    override.restore()
    expect(Object.keys(env)).toEqual([])
  })

  it('leaves process.env alone', async () => {
    const { env } = readerEnv()
    const before = process.env.MEDIA_DIR

    using override = overrideEnv(env, { MEDIA_DIR: '/tmp/c' })

    expect(override).toBeDefined()
    expect(process.env.MEDIA_DIR).toBe(before)
  })
})

describe('kay env against compose and .env.example', () => {
  const env = 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({\n  DATABASE_URL: s.String(),\n  SESSION_SECRET: s.Secret(),\n  DISCORD_ID: s.String({ requiredInProduction: true }),\n  MODE: s.String({ default: \'fast\' }),\n}))\n'
  const files = {
    'kay.config.ts': 'export default { favicon: false }\n',
    'src/env.ts': env,
    '.env.example': '# production\nSESSION_SECRET=\nexport DATABASE_URL="postgres://x"\nDISCORD_ID=\nPOSTGRES_PASSWORD=\n',
    'app.env': 'DISCORD_ID=1\n',
    'compose.yaml': 'services:\n  db:\n    image: postgres\n    environment:\n      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set it}\n  app:\n    env_file: [app.env]\n    environment:\n      SESSION_SECRET: ${SESSION_SECRET:-fallback}\n      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD}@db/app\n',
  }
  const run = async (root: string, args: string[]) => {
    const { stdout, stderr, code } = await kay(['env', ...args, '--format', 'json'], root)

    return { code, stderr, findings: (JSON.parse(stdout) as { findings?: { file: string, line: number, column: number, code: string | null, severity: string, message: string }[] }).findings }
  }

  it('passes when compose sets each variable production needs and the example lists them', async () => {
    const root = await project(files)
    const { code, findings } = await run(root, ['--compose', 'compose.yaml', '--example', '.env.example'])

    expect(findings).toEqual([])
    expect(code).toBe(0)
  })

  it('names a variable no compose service sets, in the file it is missing from', async () => {
    const root = await project({ ...files, 'app.env': '' })
    const { code, findings } = await run(root, ['--compose', 'compose.yaml'])

    expect(code).toBe(1)
    expect(findings).toEqual([{ file: 'compose.yaml', line: 1, column: 1, severity: 'error', code: null, message: 'DISCORD_ID is required in production (src/env.ts) and no service of compose.yaml sets it' }])
  })

  it('counts a variable from any of several compose files, a bare list entry and an env_file', async () => {
    const root = await project({ ...files, 'app.env': '', 'compose.override.yaml': 'services:\n  app:\n    environment:\n      - DISCORD_ID\n' })

    expect((await run(root, ['--compose', 'compose.yaml', '--compose', 'compose.override.yaml'])).findings).toEqual([])
  })

  it('names a variable only in .env.example, and counts a literal of compose or of an env_file as needing no line there', async () => {
    const root = await project({ ...files, '.env.example': 'STRAY=\nSESSION_SECRET=\nPOSTGRES_PASSWORD=\n' })
    const { code, findings } = await run(root, ['--compose', 'compose.yaml', '--example', '.env.example'])
    const messages = findings!.map(({ file, line, message }) => `${file}:${line} ${message}`)

    expect(code).toBe(1)
    expect(messages).toEqual([
      '.env.example:1 STRAY is in .env.example and no schema declares it, no compose service sets it and none interpolates it',
    ])
  })

  it('skips the half it was not given, and with no compose file given, no variable is judged missing from it', async () => {
    const root = await project({ ...files, 'compose.yaml': 'services: {}\n' })

    expect((await run(root, ['--example', '.env.example'])).findings!.map(({ message }) => message)).toEqual(['POSTGRES_PASSWORD is in .env.example and no schema declares it'])
    expect((await run(root, ['--compose', 'compose.yaml'])).findings).toHaveLength(3)
  })

  it('names a file that is missing or not YAML, and an env_file that does not exist', async () => {
    const root = await project({ ...files, 'bad.yaml': 'services: [\n', 'gone.yaml': 'services:\n  app:\n    env_file: nope.env\n' })

    expect((await run(root, ['--compose', 'missing.yaml'])).findings![0]!.message).toBe('missing.yaml does not exist')
    expect((await run(root, ['--compose', 'bad.yaml'])).findings![0]!.message).toContain('bad.yaml is not valid YAML')
    expect((await run(root, ['--compose', 'gone.yaml'])).findings!.map(({ message }) => message)).toContain('env_file nope.env of gone.yaml does not exist')
  })

  it('warns of a raw read no schema declares, and exits 0 on warnings alone', async () => {
    const root = await project({
      ...files,
      'src/lib.ts': 'export const a = process.env.FOO\nexport const b = process.env[\'BAR\']\nexport const c = Bun.env.BAZ\nexport const d = process.env.NODE_ENV\nexport const e = process.env.DISCORD_ID\nexport const f = process.env.PORT\n// process.env.COMMENTED\n',
      'src/lib.test.ts': 'export const t = process.env.IN_TEST\n',
    })
    const { code, findings } = await run(root, ['--compose', 'compose.yaml', '--example', '.env.example'])

    expect(code).toBe(0)
    expect(findings!.map(({ severity, file, line, message }) => `${severity} ${file}:${line} ${message.slice(0, message.indexOf(' '))}`)).toEqual(['warning src/lib.ts:1 process.env.FOO', 'warning src/lib.ts:2 process.env.BAR', 'warning src/lib.ts:3 process.env.BAZ'])
  })

  it('is unchanged with no flag and no env key in the config, and takes the files from the config', async () => {
    const root = await project(files)

    expect((await run(root, [])).findings).toBeUndefined()

    const configured = await project({ ...files, 'kay.config.ts': 'export default { favicon: false, env: { compose: \'compose.yaml\', example: \'.env.example\' } }\n', 'app.env': '' })
    const { code, findings } = await run(configured, [])

    expect(code).toBe(1)
    expect(findings).toHaveLength(1)
  })

  it('reads env_file entries with required: false and a list KEY=value, an empty value counting as unset', async () => {
    const root = await project({
      ...files,
      'app.env': '',
      'compose.yaml': 'services:\n  app:\n    env_file:\n      - { path: gone.env, required: false }\n      - path: app.env\n    environment:\n      - DISCORD_ID=\n      - SESSION_SECRET=abc\n      - DATABASE_URL=postgres://x\n',
    })
    const { findings } = await run(root, ['--compose', 'compose.yaml'])

    expect(findings!.map(({ message }) => message)).toEqual(['DISCORD_ID is required in production (src/env.ts) and no service of compose.yaml sets it'])
  })

  it('names a .env.example that is missing on disk', async () => {
    const root = await project(files)

    expect((await run(root, ['--example', 'nope.example'])).findings!.map(({ message }) => message)).toEqual(['nope.example does not exist'])
  })

  it('reads a $$ escape, a comment and a one-line destructuring as they are', async () => {
    const root = await project({
      ...files,
      'compose.yaml': `${files['compose.yaml']}    command: echo $$HOME\n# $COMMENTED\n`,
      '.env.example': `${files['.env.example']}HOME=\nCOMMENTED=\n`,
      'src/lib.ts': 'const { ONE, TWO: two = 1 } = process.env // process.env.TRAILING\nexport const a = [ONE, two]\n',
      'src/lib.spec.ts': 'export const t = process.env.IN_SPEC\n',
      'src/lib.mjs': 'export const m = process.env.IN_MJS\n',
    })
    const { findings } = await run(root, ['--compose', 'compose.yaml', '--example', '.env.example'])

    expect(findings!.map(({ severity, message }) => `${severity} ${message.split(' ', severity === 'warning' ? 1 : 2).join(' ')}`).sort()).toEqual([
      'error COMMENTED is',
      'error HOME is',
      'warning process.env.IN_MJS',
      'warning process.env.ONE',
      'warning process.env.TWO',
    ])
  })

  it('reports a module that does not load and judges nothing undeclared against an incomplete set', async () => {
    const root = await project({ ...files, 'src/broken.ts': 'import { defineEnv } from \'kay/server\'\nimport \'./missing\'\n\nexport const env = defineEnv({} as never)\n', '.env.example': `${files['.env.example']}STRAY=\n`, 'src/lib.ts': 'export const a = process.env.FOO\n' })
    const { code, findings } = await run(root, ['--compose', 'compose.yaml', '--example', '.env.example'])

    expect(code).toBe(1)
    expect(findings!.map(({ file, message }) => `${file} ${message.slice(0, 26)}`)).toEqual(['src/broken.ts src/broken.ts did not load'])
  })

  it('refuses a config whose checks or env are the wrong shape, naming the key', async () => {
    const bad = async (config: string) => kay(['check', await project({ ...files, 'kay.config.ts': config })], process.cwd())

    expect((await bad('export default { checks: 42 }\n')).stderr).toContain('`checks` in kay.config.ts is a list of functions')
    expect((await bad('export default { env: { compose: 42 } }\n')).stderr).toContain('`env` in kay.config.ts is `{ compose, example }`')
    expect((await bad('export default { env: \'x\' }\n')).stderr).toContain('`env` in kay.config.ts is `{ compose, example }`')
  })

  it('prints the findings as text and exits 1 on an error', async () => {
    const root = await project({ ...files, 'app.env': '' })
    const { stderr, code } = await kay(['env', '--compose', 'compose.yaml'], root)

    expect(code).toBe(1)
    expect(stderr).toContain('DISCORD_ID is required in production')
  })

  it('runs inside kay check from the config, its findings counting under --deny-warnings', async () => {
    const root = await project({ ...files, 'kay.config.ts': 'export default { favicon: false, env: { compose: \'compose.yaml\', example: \'.env.example\' } }\n', 'tsconfig.json': '{ "extends": "kay/tsconfig.json" }\n', 'src/lib.ts': 'export const a = process.env.FOO\n', 'src/routes/index.kay': 'h1 Hi\n' })
    const checked = async (args: string[]) => kay(['check', '--format', 'json', ...args], root)
    const warning = JSON.parse((await checked([])).stdout) as { errors: number, warnings: number, problems: { file: string, message: string }[] }

    expect(warning.problems.map(({ file, message }) => `${file} ${message.slice(0, message.indexOf(' '))}`)).toContain('src/lib.ts process.env.FOO')
    expect((await checked([])).code).toBe(0)
    expect((await checked(['--deny-warnings'])).code).toBe(1)
    expect((await checked(['--only', 'seo'])).code).toBe(0)
  })
})

describe('kay check --fix on raw environment reads', () => {
  const config = { 'kay.config.ts': 'export default { favicon: false, env: { example: \'.env.example\' } }\n', '.env.example': '', 'tsconfig.json': '{ "extends": "kay/tsconfig.json" }\n', 'src/routes/index.kay': 'h1 Hi\n' }
  const read = async (root: string, path: string) => Bun.file(join(root, path)).text()
  const names = async (root: string) => (JSON.parse((await kay(['env', '--format', 'json'], root)).stdout) as { variables: { name: string, source: string, default?: unknown }[] }).variables.filter(({ source }) => source !== 'kay')

  it('declares the reads in a new src/env.ts, keeps a default, rewrites the reads and imports env in sorted order', async () => {
    const root = await project({ ...config, 'src/lib.ts': 'import { join } from \'node:path\'\nimport { x } from \'./x\'\n\nexport const a = process.env.FOO ?? \'bar\'\nexport const b = process.env[\'BAZ\']\nexport const c = Bun.env.FOO ?? "bar"\nexport const d = join(process.env.DIR ?? \'.\', \'x\')\n', 'src/x.ts': 'export const x = 1\n' })
    const { stderr, code } = await kay(['check', '--fix'], root)

    expect(code).toBe(0)
    expect(stderr).not.toContain('is read with no schema')
    expect((await kay(['check'], root)).stderr).not.toContain('is read with no schema')
    expect(await read(root, 'src/env.ts')).toBe('import { defineEnv, s } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({\n  BAZ: s.Optional(s.String()),\n  DIR: s.String({ default: \'.\' }),\n  FOO: s.String({ default: \'bar\' }),\n}))\n')
    expect(await read(root, 'src/lib.ts')).toBe('import { join } from \'node:path\'\nimport { env } from \'./env\'\nimport { x } from \'./x\'\n\nexport const a = env.FOO\nexport const b = env.BAZ\nexport const c = env.FOO\nexport const d = join(env.DIR, \'x\')\n')
    expect((await names(root)).map(({ name, default: fallback }) => [name, fallback])).toEqual([['BAZ', undefined], ['DIR', '.'], ['FOO', 'bar']])
  })

  it('adds to the schema the app already has instead of making a second', async () => {
    const root = await project({ ...config, 'src/config.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({\n  OLD: s.Optional(s.String()),\n}))\n', 'src/deep/lib.ts': 'export const a = process.env.FOO ?? \'bar\'\n' })

    await kay(['check', '--fix'], root)
    expect(await read(root, 'src/config.ts')).toContain('{\n  FOO: s.String({ default: \'bar\' }),\n  OLD: s.Optional(s.String()),\n}))')
    expect(await read(root, 'src/deep/lib.ts')).toBe('import { env } from \'../config\'\n\nexport const a = env.FOO\n')
    expect(Bun.file(join(root, 'src/env.ts')).size).toBe(0)
  })

  it('leaves the shapes it cannot rewrite safely, with their warning', async () => {
    const root = await project({
      ...config,
      'src/assigned.ts': 'process.env.SET_ME = \'x\'\nexport const a = process.env.SET_ME\n',
      'src/destructured.ts': 'const { DESTR } = process.env\nexport const b = DESTR\n',
      'src/conflict.ts': 'export const c = process.env.TWO ?? \'a\'\nexport const d = process.env.TWO ?? \'b\'\n',
      'src/shadow.ts': 'const env = 1\nexport const e = [env, process.env.SHADOWED]\n',
      'src/string.ts': 'export const f = \'process.env.QUOTED\'\n',
      'src/page.kay': '---\nconst key = process.env.IN_KAY\n---\np = key\n',
      'src/template.ts': 'export const h = `process.env.IN_TEXT ${process.env.IN_EXPR}`\nexport const own = process.env.hasOwnProperty(\'x\')\n',
    })
    const { stderr } = await kay(['check', '--fix'], root)

    expect(stderr).toContain('process.env.SET_ME is read')
    expect(stderr).toContain('process.env.DESTR is read')
    expect(stderr).toContain('process.env.SHADOWED is read')
    expect(stderr).toContain('process.env.QUOTED is read')
    expect(await read(root, 'src/page.kay')).toContain('process.env.IN_KAY')
    expect(await read(root, 'src/template.ts')).toContain('`process.env.IN_TEXT ${env.IN_EXPR}`')
    expect(await read(root, 'src/template.ts')).toContain('process.env.hasOwnProperty')
    expect(await read(root, 'src/assigned.ts')).toBe('process.env.SET_ME = \'x\'\nexport const a = process.env.SET_ME\n')
    expect(await read(root, 'src/shadow.ts')).toContain('process.env.SHADOWED')
    // Two different defaults declare the variable with none, and the reads keep theirs.
    expect(await read(root, 'src/conflict.ts')).toBe('import { env } from \'./env\'\n\nexport const c = env.TWO ?? \'a\'\nexport const d = env.TWO ?? \'b\'\n')
    expect(await read(root, 'src/env.ts')).toContain('TWO: s.Optional(s.String()),')
  })

  it('does nothing without --fix and where a schema in another shape exists', async () => {
    const root = await project({ ...config, 'src/lib.ts': 'export const a = process.env.FOO\n' })

    await kay(['check'], root)
    expect(await read(root, 'src/lib.ts')).toBe('export const a = process.env.FOO\n')

    const other = await project({ ...config, 'src/lib.ts': 'export const a = process.env.FOO\n', 'src/schema.ts': 'import { defineEnv } from \'kay/server\'\n\nconst shape = {} as never\n\nexport const settings = defineEnv(shape)\n' })

    await kay(['check', '--fix'], other)
    expect(await read(other, 'src/lib.ts')).toBe('export const a = process.env.FOO\n')
  })

  it('leaves a byte order mark file alone, rewrites two reads on a line with CRLF, and fills a `t.Object({})` with no field', async () => {
    const root = await project({
      ...config,
      'src/bom.ts': '\uFEFFexport const a = process.env.BOMMED\n',
      'src/two.ts': 'export const b = [process.env.ONE ?? \'1\', process.env.TWO]\r\nexport const c = process.env.ONE ?? \'1\'\r\n',
      'src/schema.ts': 'import { t } from \'elysia\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(t.Object({}))\n',
    })
    const { stderr } = await kay(['check', '--fix'], root)

    expect(stderr).toContain('process.env.BOMMED is read')
    expect(await readFile(join(root, 'src/bom.ts'), 'utf8')).toBe('\uFEFFexport const a = process.env.BOMMED\n')
    expect(await read(root, 'src/two.ts')).toBe('import { env } from \'./schema\'\r\n\r\nexport const b = [env.ONE, env.TWO]\r\nexport const c = env.ONE\r\n')
    expect(await read(root, 'src/schema.ts')).toContain('t.Object({\n  ONE: t.String({ default: \'1\' }),\n  TWO: t.Optional(t.String()),\n})')
  })

  it('reads past a regular expression holding a quote, a backtick or two slashes', async () => {
    const root = await project({
      ...config,
      'src/regex.ts': [
        'export const quote = /["\']/',
        'export const a = process.env.AFTER_QUOTE',
        'export const tick = /`+/',
        'export const b = process.env.AFTER_TICK',
        'export const url = /^https?:\\/\\//, c = process.env.SAME_LINE',
        'export const d = [/[/`]/.test(\'x\'), process.env.AFTER_CLASS]',
        'export const e = 4 / 2 / process.env.DIVIDED',
        'export const f = `${/`/.source}`',
        'let i = 1',
        'export const inc = i++ / 2 + "x/", h = process.env.AFTER_INCREMENT',
        'export const member = { in: 4 }.in / 2 / process.env.AFTER_MEMBER',
        'export const café = 8 / 2 / process.env.AFTER_UNICODE',
        'export const g = process.env.AFTER_TEMPLATE',
        '',
      ].join('\n'),
    })

    await kay(['check', '--fix'], root)

    const fixed = await read(root, 'src/regex.ts')

    for (const name of ['AFTER_QUOTE', 'AFTER_TICK', 'SAME_LINE', 'AFTER_CLASS', 'DIVIDED', 'AFTER_TEMPLATE', 'AFTER_INCREMENT', 'AFTER_MEMBER', 'AFTER_UNICODE'])
      expect(fixed).toContain(`env.${name}`)

    expect(fixed).not.toContain('process.env')
  })

  it('changes only the scoped files, and nothing during kay upgrade', async () => {
    const files = { ...config, 'src/a.ts': 'export const a = process.env.SHARED\n', 'src/b.ts': 'export const b = process.env.SHARED\n' }
    const root = await project(files)

    await kay(['check', '--fix', 'src/a.ts'], root)
    expect(await read(root, 'src/a.ts')).toContain('process.env.SHARED')
    expect(await read(root, 'src/b.ts')).toContain('process.env.SHARED')

    const upgrading = await project(files)

    await kay(['check', '--fix'], upgrading, { KAY_UPGRADE_FROM: '1.0.0' })
    expect(await read(upgrading, 'src/a.ts')).toContain('process.env.SHARED')
  })
})
