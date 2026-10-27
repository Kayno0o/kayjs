import type { TSchema } from 'elysia'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { t } from 'elysia'
import { defineConfig, loadConfig } from '../src/config'
import { s } from '../src/runtime/schema'
import { defineEnv } from '../src/server'
import { publicEnvFiles } from '../src/server/env-state'
import { overrideEnv } from '../src/test'
import { kayInProject } from './check-helper'
import { freePort } from './free-port'
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

async function kaySpawned(args: string[], cwd: string, env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: { PATH: process.env.PATH!, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, output: stderr, report: stdout }
}

// The first run of a project by `env` or `check` is in this process; a case that needs a process without the modules the other cases loaded, such as an extension's, or is about the command as a program, spawns it.
async function kay(args: string[], cwd: string, env: Record<string, string> = {}, inProcess = true) {
  const name = args[0]
  const spawned = async () => kaySpawned(args, cwd, env)
  const answer = inProcess && (name === 'env' || name === 'check') && cwd !== process.cwd() ? await kayInProject(name, args.slice(1), cwd, env, spawned) : await spawned()

  return { stdout: answer.report, stderr: answer.output, code: answer.code }
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
    const run = async (cwd: string) => (await Bun.$`${process.execPath} -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; console.log(defineEnv(s.Object({ A: s.Secret() }), { NODE_ENV: 'development' }).A)`}`.cwd(cwd).env({ ...process.env, NODE_ENV: 'development' }).quiet().text()).trim()
    const a = await project({ 'a.txt': '' })
    const b = await project({ 'a.txt': '' })

    expect(await run(a)).toBe(await run(a))
    expect(await run(a)).not.toBe(await run(b))
  })

  it('mixes in a random seed kept in the checkout\'s .kay, so the same path elsewhere gives another value', async () => {
    const run = async (cwd: string) => (await Bun.$`${process.execPath} -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; console.log(defineEnv(s.Object({ A: s.Secret() }), { NODE_ENV: 'development' }).A)`}`.cwd(cwd).env({ ...process.env, NODE_ENV: 'development' }).quiet().text()).trim()
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
    const run = async (cwd: string) => Bun.$`${process.execPath} -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; try { console.log(defineEnv(s.Object({ A: s.Secret() }), { NODE_ENV: 'development' }).A) } catch (error) { console.log(error.message) }`}`.cwd(cwd).env({ ...process.env, NODE_ENV: 'development' }).quiet().text()
    const root = await project({ '.kay/dev-secret': 'short' })
    const first = (await run(root)).trim()

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect((await Bun.file(join(root, '.kay/dev-secret')).text()).length).toBeGreaterThanOrEqual(64)
    expect((await run(root)).trim()).toBe(first)

    const blocked = await project({ '.kay': 'a file, not a folder' })

    expect(await run(blocked)).toContain('the development secret cannot be kept in')
    expect(await run(blocked)).toContain('set A')
  })

  it('keeps a seed in memory under test, writing nothing to .kay and agreeing with a seed file that exists', async () => {
    const run = async (cwd: string, mode: string) => (await Bun.$`${process.execPath} -e ${`import { s } from ${JSON.stringify(join(import.meta.dir, '../src/runtime/schema'))}; import { defineEnv } from ${JSON.stringify(join(import.meta.dir, '../src/server'))}; const env = s.Object({ A: s.Secret() }); console.log(defineEnv(env, { NODE_ENV: '${mode}' }).A + ' ' + defineEnv(env, { NODE_ENV: '${mode}' }).A)`}`.cwd(cwd).env({ ...process.env, NODE_ENV: mode }).quiet().text()).trim().split(' ')
    const blocked = await project({ '.kay': 'a file, not a folder' })
    const [first, again] = await run(blocked, 'test')

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(again).toBe(first)
    expect(await Bun.file(join(blocked, '.kay')).text()).toBe('a file, not a folder')

    const kept = await project({ 'a.txt': '' })
    const [fromDevelopment] = await run(kept, 'development')

    expect((await run(kept, 'test'))[0]).toBe(fromDevelopment)

    const fresh = await project({ 'a.txt': '' })

    await run(fresh, 'test')
    expect(await Bun.file(join(fresh, '.kay/dev-secret')).exists()).toBe(false)
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

describe('the placeholder --load gives a string the build lacks', () => {
  const LOADING = Symbol.for('kay.loading')
  const BUILDING = Symbol.for('kay.building')

  function loadedWith(names: Record<string, TSchema>): Record<string, unknown> {
    const global = globalThis as Record<symbol, unknown>

    global[BUILDING] = true
    global[LOADING] = true

    try {
      return defineEnv(s.Object(names), { NODE_ENV: 'production' })
    }
    finally {
      delete global[BUILDING]
      delete global[LOADING]
    }
  }

  it('is accepted by the field\'s format, pattern and enum, so a module validating it at load still loads', () => {
    const env = loadedWith({
      PLAIN: s.String(),
      URL_VALUE: s.String({ format: 'uri' }),
      MAIL: s.String({ format: 'email' }),
      ID: s.String({ pattern: '^[0-9]+$' }),
      MODE: s.String({ enum: ['b', 'a'] }),
      LONG: s.String({ minLength: 40 }),
      LONG_URL: s.String({ format: 'uri', minLength: 60 }),
      KEY: s.String({ pattern: '^sk_' }),
      DB: s.String({ pattern: '^postgres://' }),
      UPPER: s.String({ pattern: '^[A-Z]+$' }),
      ONLY: s.String({ const: 'x' }),
      SAMPLE_LESS: s.String({ pattern: '^zz-[0-9]{3}-q$' }),
      DECODED: t.Transform(t.String()).Decode((value) => { throw new Error(`decoded ${value}`) }).Encode(value => value),
    })

    expect(env.PLAIN).toBe('kay-load-placeholder-PLAIN'.padEnd(32, '_'))
    expect(() => new URL(env.URL_VALUE as string)).not.toThrow()
    expect(env.MAIL).toContain('@')
    expect(env.ID).toMatch(/^\d+$/)
    expect(env.MODE).toBe('b')
    expect((env.LONG as string).length).toBe(40)
    expect(() => new URL(env.LONG_URL as string)).not.toThrow()
    expect((env.LONG_URL as string).length).toBeGreaterThanOrEqual(60)
    expect(env.KEY).toMatch(/^sk_/)
    expect(env.DB).toMatch(/^postgres:\/\//)
    expect(env.UPPER).toMatch(/^[A-Z]+$/)
    expect(env.ONLY).toBe('x')
    // A pattern none of the samples meets leaves the plain placeholder rather than failing the load.
    expect(env.SAMPLE_LESS).toBe('kay-load-placeholder-SAMPLE_LESS'.padEnd(32, '_'))
  })
})

describe('kay env', () => {
  const files = {
    'kay.config.ts': 'import { Elysia, t } from \'elysia\'\n\nconst lib = { name: \'lib\', env: t.Object({ LIB_KEY: t.String({ description: \'the library\\\'s key\', requiredInProduction: true }), LIB_MODE: t.String({ default: \'fast\' }) }) }\n\nexport default { favicon: false, extensions: [lib] }\n',
    'src/server.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nthrow new Error(\'the entry must not run\')\nexport const env = defineEnv(s.Object({ ENTRY_ONLY: s.String() }))\n',
    'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nconsole.log(\'loading the env\')\n\nexport const env = defineEnv(s.Object({\n  DATABASE_URL: s.String(),\n  SESSION_SECRET: s.String({ default: \'dev\', requiredInProduction: true }),\n  PORT: s.Integer({ default: 8080 }),\n  DEBUG: s.Optional(s.Boolean()),\n}))\n',
    'src/broken.ts': 'import { defineEnv } from \'kay/server\'\nimport \'./missing\'\n\nexport const env = defineEnv({} as never)\n',
  }

  it('lists an s.Public field as public, and sends the browser an environment', async () => {
    const root = await project({
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ MAP_KEY: s.Public(s.String()), DATABASE_URL: s.String() }))\n',
    })
    const { stdout, code } = await kay(['env', '--format', 'json'], root)
    const rows = (JSON.parse(stdout) as { variables: Record<string, unknown>[] }).variables

    expect(code).toBe(0)
    expect(rows.find(row => row.name === 'MAP_KEY')).toEqual({ name: 'MAP_KEY', source: 'src/env.ts', type: 'string', required: 'always', public: true })
    expect(rows.find(row => row.name === 'DATABASE_URL')).toEqual({ name: 'DATABASE_URL', source: 'src/env.ts', type: 'string', required: 'always' })
    expect((await loadConfig(root)).publicEnv).toBeDefined()
    expect(publicEnvFiles(root)).toEqual(['src/env.ts'])
    expect(publicEnvFiles(await project({ 'src/env.ts': 'const s = 1\n', 'src/env.test.ts': 's.Public(1)\n', 'src/a.kay': 'p s.Public(1)\n' }))).toEqual(['src/a.kay'])
  })

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
    const { stdout, stderr, code } = await kay(['env', '--format', 'json'], root, {}, false)

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
    expect(row('ENTRY_ONLY')).toBeUndefined()
    expect(listed.variables.filter(variable => variable.source === 'kay').map(variable => variable.name)).toEqual(['PORT', 'HOST', 'SITE_URL', 'KAY_SECRET'])
    expect(listed.unread.map(({ file }) => file)).toEqual(['src/broken.ts'])
    expect(listed.unread[0]!.error).toContain('missing')
  })

  it('lists KAY_MCP_KEY and KAY_MCP_KEY_FILE while mcp.key asks for a key from the environment, optional for { file }, and none for a string', async () => {
    const listing = async (mcp: string) => {
      const root = await project({ ...files, 'kay.config.ts': `export default { favicon: false, mcp: ${mcp} }\n` })
      const listed = JSON.parse((await kay(['env', '--format', 'json'], root)).stdout) as { variables: { name: string, source: string, required: string | false, secret?: true }[] }

      return (name: string) => listed.variables.find(variable => variable.name === name)
    }

    const wanted = await listing('{ key: true }')

    expect(wanted('KAY_MCP_KEY')).toMatchObject({ source: 'kay', required: 'production', secret: true })
    expect(wanted('KAY_MCP_KEY_FILE')).toMatchObject({ source: 'kay', required: false })

    const made = await listing('{ key: { file: "data/mcp-key" } }')

    expect(made('KAY_MCP_KEY')).toMatchObject({ source: 'kay', required: false, secret: true })
    expect(made('KAY_MCP_KEY_FILE')).toMatchObject({ required: false })

    for (const mcp of ['true', '{ key: "a-literal-key-0123456789" }', '{ key: false }', '{}']) {
      const none = await listing(mcp)

      expect(none('KAY_MCP_KEY')).toBeUndefined()
      expect(none('KAY_MCP_KEY_FILE')).toBeUndefined()
    }
  })

  it('lists KAY_PROXY_KEY and KAY_PROXY_KEY_FILE while proxy.key is set, and writes them to .env.example', async () => {
    const root = await project({ ...files, 'kay.config.ts': 'export default { favicon: false, proxy: { key: "x-upstream-key" } }\n' })
    const { stdout, code } = await kay(['env', '--format', 'json'], root)
    const listed = JSON.parse(stdout) as { variables: { name: string, source: string, required: string | false, secret?: true }[] }
    const row = (name: string) => listed.variables.find(variable => variable.name === name)

    expect(code).toBe(0)
    expect(row('KAY_PROXY_KEY')).toMatchObject({ source: 'kay', required: 'production', secret: true })
    expect(row('KAY_PROXY_KEY_FILE')).toMatchObject({ source: 'kay', required: false })

    expect((await kay(['env', '--write'], root)).stderr).toContain('KAY_PROXY_KEY, KAY_PROXY_KEY_FILE')

    const text = await Bun.file(join(root, '.env.example')).text()

    expect(text).toContain('required in production\nKAY_PROXY_KEY=\n')
    expect(text).toContain('# KAY_PROXY_KEY_FILE=\n')
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
      'kay.config.ts': 'import { mail } from \'@kaynooo/kayjs-mail\'\n\nexport default { favicon: false, extensions: [mail({ module: \'./src/defineEnv-mail/mail.ts\' })] }\n',
      'src/defineEnv-mail/mail.ts': 'import { mailer } from \'@kaynooo/kayjs-mail\'\nimport { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ OWN: s.String() }))\nexport const mail = mailer({ optional: true })\n',
    })
    const { stdout, stderr, code } = await kay(['env', '--format', 'json'], root, {}, false)

    expect(code, stderr).toBe(0)

    const listed = JSON.parse(stdout) as { variables: { name: string, source: string, required: string | false }[] }
    const rows = (name: string) => listed.variables.filter(variable => variable.name === name)

    expect(rows('OWN')).toEqual([expect.objectContaining({ source: 'src/defineEnv-mail/mail.ts' })])
    expect(rows('MAIL_URL')).toEqual([expect.objectContaining({ source: 'src/defineEnv-mail/mail.ts', required: false })])
    expect(rows('MAIL_INSECURE')).toHaveLength(1)
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

  describe('with s.Public', () => {
    const files = {
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true }, include: ['src', '.kay/types'] }),
      'kay.config.ts': 'export default { favicon: false }\n',
      'src/public-env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({ SITE_NAME: s.Public(s.String({ default: \'built\' })) }))\n\nconst counted = globalThis as { loads?: number }\n\ncounted.loads = (counted.loads ?? 0) + 1\n',
      'src/routes/index.kay': '---\nimport { publicEnv } from \'kay\'\nimport Picker from \'../picker.kay\'\n---\np#name {publicEnv.SITE_NAME}\nPicker\n',
      'src/server.ts': 'import { Elysia } from \'elysia\'\nimport { pages } from \'kay/server\'\n\nawait new Elysia().get(\'/loads\', () => String((globalThis as { loads?: number }).loads)).use(await pages()).listen({ port: Number(process.env.PORT), hostname: \'127.0.0.1\' })\n',
      'src/picker.kay': '---\nimport { publicEnv } from \'kay\'\n\nlet count = 0\n---\nbutton#pick(onClick={() => count++}) {publicEnv.SITE_NAME} {count}\n',
    }

    const stops = new WeakMap<object, Promise<string>>()

    async function stderrAfterExit(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
      await child.exited

      return new Response(child.stderr).text()
    }

    // Stops the executable once and gives what it wrote to stderr.
    async function stopped(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
      if (!stops.has(child)) {
        child.kill()
        stops.set(child, stderrAfterExit(child))
      }

      return stops.get(child)!
    }

    async function served(options: { from: 'source' | 'elsewhere' }) {
      const root = await project(files)
      const built = Bun.spawn([process.execPath, cli, 'build', root, '--compile', join(root, 'server'), '--no-check'], { stdout: 'pipe', stderr: 'pipe' })

      expect(await built.exited, await new Response(built.stderr).text()).toBe(0)

      // A runtime stage of a container image holds the executable alone.
      const cwd = options.from === 'source' ? root : await scratchDir('env-run-')

      dirs.push(cwd)

      if (cwd !== root)
        await Bun.write(join(cwd, 'server'), Bun.file(join(root, 'server')), { mode: 0o755 })

      const port = freePort()
      const child = Bun.spawn([join(cwd, 'server')], { cwd, env: { PATH: process.env.PATH!, PORT: String(port), HOST: '127.0.0.1', KAY_EPHEMERAL_SECRET: '1', SITE_NAME: 'booted' }, stdout: 'pipe', stderr: 'pipe' })

      try {
        for (const limit = Date.now() + 20_000; Date.now() < limit; await Bun.sleep(50)) {
          try {
            const page = await fetch(`http://127.0.0.1:${port}/`)
            const module = await fetch(`http://127.0.0.1:${port}/_kay/env.js`)
            const loads = await (await fetch(`http://127.0.0.1:${port}/loads`)).text()

            return { page: { status: page.status, text: await page.text() }, module: { status: module.status, text: await module.text() }, loads, stderr: await stopped(child) }
          }
          catch {}
        }

        throw new Error(`the executable never answered: ${await stopped(child)}`)
      }
      finally {
        await stopped(child)
      }
    }

    it('fills publicEnv and serves it with no src beside the executable', async () => {
      const { page, module, loads, stderr } = await served({ from: 'elsewhere' })

      expect(page.status, stderr).toBe(200)
      expect(page.text).toContain('<p id="name">booted</p>')
      expect(loads).toBe('1')
      expect(page.text).toMatch(/<button id="pick"><!--\[-->booted/)
      expect(page.text).toContain('/_kay/env.js')
      expect(module.status).toBe(200)
      expect(module.text).toBe('export default {"SITE_NAME":"booted"}\n')
    }, 90_000)

    it('refuses to compile a .kay file declaring s.Public, as the server on disk does', async () => {
      const root = await project({ ...files, 'src/fence.kay': '---\nimport { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\ndefineEnv(s.Object({ A: s.Public(s.String({ default: \'a\' })) }))\n---\np x\n' })
      const built = Bun.spawn([process.execPath, cli, 'build', root, '--compile', join(root, 'server'), '--no-check'], { stdout: 'pipe', stderr: 'pipe' })

      expect(await built.exited).not.toBe(0)
      expect(await new Response(built.stderr).text()).toContain('src/fence.kay declares an s.Public field')
    }, 90_000)

    it('does the same run from its source folder, loading the module once', async () => {
      const { page, module, loads, stderr } = await served({ from: 'source' })

      expect(page.status, stderr).toBe(200)
      expect(page.text).toContain('<p id="name">booted</p>')
      expect(loads).toBe('1')
      expect(module.text).toBe('export default {"SITE_NAME":"booted"}\n')
    }, 90_000)
  })
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

  it('names a compose file setting neither KAY_PROXY_KEY nor KAY_PROXY_KEY_FILE while proxy.key is set, and passes with either', async () => {
    const config = 'export default { favicon: false, proxy: { key: "x-upstream-key" } }\n'
    const withKey = (line: string) => files['compose.yaml'].replace('      SESSION_SECRET', `      ${line}\n      SESSION_SECRET`)
    const messages = async (compose: string, kayConfig = config) => (await run(await project({ ...files, 'kay.config.ts': kayConfig, 'compose.yaml': compose }), ['--compose', 'compose.yaml'])).findings!.map(({ message }) => message)

    expect(await messages(files['compose.yaml'])).toEqual(['KAY_PROXY_KEY is required in production (proxy.key in kay.config.ts) and no service of compose.yaml sets it or KAY_PROXY_KEY_FILE'])
    expect(await messages(withKey('KAY_PROXY_KEY: abc'))).toEqual([])
    expect(await messages(withKey('KAY_PROXY_KEY_FILE: /run/secrets/proxy'))).toEqual([])
    expect(await messages(files['compose.yaml'], files['kay.config.ts'])).toEqual([])
  })

  it('names a compose file setting neither KAY_MCP_KEY nor KAY_MCP_KEY_FILE while mcp.key asks for one, and passes with either, or with { file }', async () => {
    const config = 'export default { favicon: false, mcp: { key: true } }\n'
    const withKey = (line: string) => files['compose.yaml'].replace('      SESSION_SECRET', `      ${line}\n      SESSION_SECRET`)
    const messages = async (compose: string, kayConfig = config) => (await run(await project({ ...files, 'kay.config.ts': kayConfig, 'compose.yaml': compose }), ['--compose', 'compose.yaml'])).findings!.map(({ message }) => message)

    expect(await messages(files['compose.yaml'])).toEqual(['KAY_MCP_KEY is required in production (mcp.key in kay.config.ts) and no service of compose.yaml sets it or KAY_MCP_KEY_FILE'])
    expect(await messages(withKey('KAY_MCP_KEY: abc'))).toEqual([])
    expect(await messages(withKey('KAY_MCP_KEY_FILE: /run/secrets/mcp'))).toEqual([])
    expect(await messages(files['compose.yaml'], 'export default { favicon: false, mcp: { key: { file: "data/mcp-key" } } }\n')).toEqual([])
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

  it('counts a top-level secret or config compose reads from its environment as a use of that variable in .env.example', async () => {
    const compose = `${files['compose.yaml']}secrets:\n  hf_token:\n    environment: HF_TOKEN\nconfigs:\n  banner:\n    environment: BANNER\n`
    const root = await project({ ...files, 'compose.yaml': compose, '.env.example': 'HF_TOKEN=\nBANNER=\nSTRAY=\nSESSION_SECRET=\n' })

    expect((await run(root, ['--compose', 'compose.yaml', '--example', '.env.example'])).findings!.map(({ message }) => message)).toEqual([
      'STRAY is in .env.example and no schema declares it, no compose service sets it and none interpolates it',
    ])
  })

  it('skips the half it was not given, and with no compose file given, no variable is judged missing from it', async () => {
    const root = await project({ ...files, 'compose.yaml': 'services: {}\n' })

    expect((await run(root, ['--example', '.env.example'])).findings!.map(({ message }) => message)).toEqual(['POSTGRES_PASSWORD is in .env.example and no schema declares it'])
    expect((await run(root, ['--compose', 'compose.yaml'])).findings).toHaveLength(3)
  })

  it('asks compose for MAIL_URL of a mailer that is not optional, and not of an optional one, whatever file builds it', async () => {
    const mailer = async (options: string) => project({
      'kay.config.ts': 'import { mail } from \'@kaynooo/kayjs-mail\'\n\nexport default { favicon: false, extensions: [mail({ module: \'./src/mail.ts\' })] }\n',
      'src/mail.ts': `import { mailer } from '@kaynooo/kayjs-mail'\n\nexport const mail = mailer(${options})\n`,
      'compose.yaml': 'services:\n  app:\n    environment:\n      SITE_URL: https://example.com\n',
    })
    // Spawned, as the mailer declares its variables only where it delivers over SMTP, which a test process does not.
    const messages = async (options: string) => {
      const { stdout } = await kay(['env', '--compose', 'compose.yaml', '--format', 'json'], await mailer(options), {}, false)

      return (JSON.parse(stdout) as { findings: { message: string }[] }).findings.map(({ message }) => message)
    }

    expect(await messages('{ optional: true }')).toEqual([])
    expect(await messages('{}')).toEqual([expect.stringContaining('MAIL_URL is required')])

    const missing = await project({ 'kay.config.ts': 'import { mail } from \'@kaynooo/kayjs-mail\'\n\nexport default { favicon: false, extensions: [mail({ module: \'./src/gone.ts\' })] }\n', 'compose.yaml': 'services: {}\n' })

    expect((await kay(['env', '--compose', 'compose.yaml', '--format', 'json'], missing, {}, false)).stdout).toContain('MAIL_URL')
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

  it('compares the project\'s production compose files and .env.example with no flag and no env key in the config, and takes the files from the config', async () => {
    const root = await project(files)

    expect((await run(root, [])).findings).toEqual([])
    expect((await run(await project({ ...files, 'app.env': '' }), [])).findings).toHaveLength(1)
    expect((await run(await project({ 'kay.config.ts': files['kay.config.ts'], 'src/env.ts': env }), [])).findings).toBeUndefined()

    const configured = await project({ ...files, 'kay.config.ts': 'export default { favicon: false, env: { compose: \'compose.yaml\', example: \'.env.example\' } }\n', 'app.env': '' })
    const { code, findings } = await run(configured, [])

    expect(code).toBe(1)
    expect(findings).toHaveLength(1)
  })

  it('has kay check compare the root compose files by default, and env: false turns it off for kay check and kay env', async () => {
    const broken = { ...files, 'app.env': '' }
    const problems = async (root: string) => (JSON.parse((await kay(['check', '--format', 'json'], root)).stdout) as { problems: { message: string }[] }).problems.map(({ message }) => message)
    const off = { ...broken, 'kay.config.ts': 'export default { favicon: false, env: false }\n' }

    expect(await problems(await project(broken))).toContain('DISCORD_ID is required in production (src/env.ts) and no service of compose.yaml sets it')
    expect(await problems(await project(files))).not.toContain('DISCORD_ID is required in production (src/env.ts) and no service of compose.yaml sets it')
    expect((await problems(await project(off))).filter(message => message.includes('compose.yaml'))).toEqual([])
    expect((await run(await project(off), [])).findings).toBeUndefined()
    expect((await run(await project(off), ['--compose', 'compose.yaml'])).findings).toHaveLength(1)
  })

  it('leaves a development or test compose file out of the default comparison', async () => {
    const root = await project({ 'kay.config.ts': files['kay.config.ts'], 'src/env.ts': env, 'compose.dev.yaml': 'services:\n  db:\n    image: postgres\n', 'compose.test.yaml': 'services: {}\n' })

    expect((await run(root, [])).findings).toBeUndefined()
  })

  it('writes the variables an .env.example lacks with --write, keeping what it holds, and writes none a second time', async () => {
    const root = await project({ ...files, '.env.example': '# mine\nSESSION_SECRET=keep\n' })
    const first = await kay(['env', '--write'], root)

    expect(first.stderr).toContain('.env.example: added DATABASE_URL, DISCORD_ID, MODE, PORT, HOST, SITE_URL, KAY_SECRET')

    const text = await Bun.file(join(root, '.env.example')).text()

    expect(text.startsWith('# mine\nSESSION_SECRET=keep\n\n')).toBe(true)
    expect(text).toContain('DATABASE_URL=\n')
    expect(text).toContain('# required in production\nDISCORD_ID=\n')
    expect(text).toContain('# MODE=fast\n')
    expect(text).toContain('# KAY_SECRET=\n')

    expect((await kay(['env', '--write'], root)).stderr).toContain('.env.example already lists every variable')
    expect(await Bun.file(join(root, '.env.example')).text()).toBe(text)
  })

  it('creates the .env.example --write names when it does not exist', async () => {
    const root = await project({ 'kay.config.ts': files['kay.config.ts'], 'src/env.ts': env })

    await kay(['env', '--write', '--example', 'created.env'], root)
    expect(await Bun.file(join(root, 'created.env')).text()).toContain('DISCORD_ID=')
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

  it('refuses publicEnv in the config, written in kay.config.ts or brought by an extension, and types it out of defineConfig', async () => {
    const bad = async (config: string) => kay(['check', await project({ ...files, 'kay.config.ts': config })], process.cwd())

    expect((await bad('export default { publicEnv: true }\n')).stderr).toContain('`publicEnv` in kay.config.ts is gone')
    expect((await bad('export default { extensions: [{ name: \'lib\', config: { publicEnv: true } }] }\n')).stderr).toContain('`publicEnv` in the config of the extension lib is gone')
    // @ts-expect-error the marker is kay's own, a field marked s.Public sets it
    expect(defineConfig({ publicEnv: true })).toBeDefined()
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

  it('leaves a standalone entry and what it imports, a config-time module and a file marked raw, with no warning', async () => {
    const root = await project({
      ...config,
      'package.json': '{ "scripts": { "collector": "bun build --compile src/collector/main.ts --outfile out/collector" } }\n',
      'src/collector/main.ts': 'import { url } from \'./url\'\n\nexport const a = process.env.COLLECTOR_TOKEN ?? url\n',
      'src/collector/url.ts': 'export const url = process.env.COLLECTOR_URL\n',
      'src/content.config.ts': 'export const db = process.env.CONTENT_DB\n',
      'src/marked.ts': '// kay-env: raw\nexport const b = process.env.MARKED\n',
      'src/lib.ts': 'export const c = process.env.SERVER_ONLY\n',
    })
    const { stderr } = await kay(['check', '--fix'], root)

    expect(stderr).not.toMatch(/COLLECTOR_|CONTENT_DB|MARKED/)
    expect(await read(root, 'src/collector/main.ts')).toContain('process.env.COLLECTOR_TOKEN')
    expect(await read(root, 'src/content.config.ts')).toBe('export const db = process.env.CONTENT_DB\n')
    expect(await read(root, 'src/lib.ts')).toContain('env.SERVER_ONLY')
    expect(await read(root, 'src/env.ts')).not.toMatch(/COLLECTOR_|CONTENT_DB|MARKED/)
  })

  it('follows a `.js` import, a `.kay` import, an entry outside src with --cwd, and a custom content path', async () => {
    const root = await project({
      ...config,
      'kay.config.ts': 'export default { favicon: false, content: \'app/collections.ts\', env: { example: \'.env.example\' } }\n',
      'package.json': '{ "scripts": { "a": "bun build --compile scripts/a.ts --outfile out/a.js", "b": "bun build --cwd tools --target bun b.ts --outdir dist" } }\n',
      'scripts/a.ts': 'import { one } from \'../src/one.js\'\nimport two from \'../src/two.kay\'\n\nexport const a = [one, two]\n',
      'src/one.ts': 'export const one = process.env.VIA_JS\n',
      'src/two.kay': '---\nconst two = process.env.VIA_KAY\n---\np = two\n',
      'tools/b.ts': 'export const b = process.env.VIA_CWD\n',
      'app/collections.ts': 'export const db = process.env.VIA_CONTENT\n',
      'src/lib.ts': 'export const c = process.env.SERVER_ONLY\n',
    })
    const { stderr } = await kay(['check', '--fix'], root)

    expect(stderr).not.toMatch(/warning: process.env.VIA_/)
    expect(await read(root, 'src/one.ts')).toContain('process.env.VIA_JS')
    expect(await read(root, 'src/lib.ts')).toContain('env.SERVER_ONLY')
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
