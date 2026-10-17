import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { defineEnv } from '../src/server'
import { scratchDir } from './scratch'

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

describe('kay env', () => {
  const files = {
    'kay.config.ts': 'import { Elysia, t } from \'elysia\'\n\nconst lib = { name: \'lib\', env: t.Object({ LIB_KEY: t.String({ description: \'the library\\\'s key\', requiredInProduction: true }), LIB_MODE: t.String({ default: \'fast\' }) }) }\n\nexport default { favicon: false, extensions: [lib], publicEnv: t.Object({ MAP_KEY: t.Numeric({ default: 1 }), SITE: t.Optional(t.String({ format: \'uri\' })) }) }\n',
    'src/server.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nthrow new Error(\'the entry must not run\')\nexport const env = defineEnv(s.Object({ ENTRY_ONLY: s.String() }))\n',
    'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nconsole.log(\'loading the env\')\n\nexport const env = defineEnv(s.Object({\n  DATABASE_URL: s.String(),\n  SESSION_SECRET: s.String({ default: \'dev\', requiredInProduction: true }),\n  PORT: s.Integer({ default: 8080 }),\n  DEBUG: s.Optional(s.Boolean()),\n}))\n',
    'src/broken.ts': 'import { defineEnv } from \'kay/server\'\nimport \'./missing\'\n\nexport const env = defineEnv({} as never)\n',
  }

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
