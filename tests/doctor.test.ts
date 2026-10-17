import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { version } from '../package.json'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const dirs: string[] = []
const [major, minor] = version.split('.')
const otherMinor = `${major}.${Number(minor) + 1}.0`

interface Check {
  name: string
  ok: boolean
  message: string
  fix?: string
}

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string> = {}): Promise<string> {
  const root = await scratchDir('doctor-')

  dirs.push(root)
  await Promise.all(Object.entries({ 'package.json': '{ "name": "app" }', ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

function installed(name: string, versionOf: string): Record<string, string> {
  return { [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: versionOf }) }
}

async function doctor(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, cli, 'doctor', '--format', 'json', ...args], { cwd, env: { PATH: process.env.PATH!, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const checks = stdout.trim() === '' ? [] : (JSON.parse(stdout) as { checks: Check[] }).checks

  return { stdout, stderr, code, checks, check: (name: string) => checks.find(found => found.name === name)! }
}

// A port nothing else holds, kept busy until `release`.
async function busyPort(): Promise<{ port: number, release: () => void }> {
  const server = createServer()

  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve))

  return { port: (server.address() as { port: number }).port, release: () => server.close() }
}

describe('kay doctor', () => {
  it('passes a healthy project, one check per line in the same order in text and JSON, exiting 0', async () => {
    const root = await project()
    const result = await doctor(root)

    expect(result.code, result.stderr).toBe(0)
    expect(result.checks.map(check => check.name)).toEqual(['bun', 'versions', 'config', 'env', 'port', 'build'])
    expect(result.checks.every(check => check.ok)).toBe(true)

    const text = Bun.spawnSync([process.execPath, cli, 'doctor'], { cwd: root, env: { PATH: process.env.PATH! } })
    const lines = text.stdout.toString().trimEnd().split('\n')

    expect(text.exitCode).toBe(0)
    expect(lines).toHaveLength(6)
    expect(lines.every(line => line.startsWith('ok '))).toBe(true)
  })

  it('refuses a path that is no directory, and an option it does not take', async () => {
    const root = await project()

    expect((await doctor(root, ['nothing-here'])).code).toBe(1)
    expect((await doctor(root, ['--nope'])).code).toBe(1)
  })

  it('compares each installed library with the kay beside it by minor, not by patch', async () => {
    const same = await doctor(await project({ 'package.json': '{ "dependencies": { "@kaynooo/kayjs": "x", "@kaynooo/kayjs-ui": "x" } }', ...installed('@kaynooo/kayjs', version), ...installed('@kaynooo/kayjs-ui', `${major}.${minor}.99`) }))

    expect(same.check('versions').ok).toBe(true)

    const drift = await doctor(await project({ 'package.json': '{ "dependencies": { "@kaynooo/kayjs": "x", "@kaynooo/kayjs-ui": "x" } }', ...installed('@kaynooo/kayjs', version), ...installed('@kaynooo/kayjs-ui', otherMinor) }))

    expect(drift.code).toBe(1)
    expect(drift.check('versions').ok).toBe(false)
    expect(drift.check('versions').message).toContain(`@kaynooo/kayjs-ui ${otherMinor}`)
    expect(drift.check('versions').message).toContain(version)
    expect(drift.check('versions').fix).toContain('bun update')
  })

  it('fails a listed library that is not installed, and ignores libraries it does not know', async () => {
    const missing = await doctor(await project({ 'package.json': '{ "dependencies": { "@kaynooo/kayjs-auth": "x", "left-pad": "1.0.0" } }' }))

    expect(missing.check('versions').ok).toBe(false)
    expect(missing.check('versions').message).toContain('@kaynooo/kayjs-auth')
    expect(missing.check('versions').message).not.toContain('left-pad')
    expect(missing.check('versions').fix).toContain('bun install')
  })

  it('reports a config that throws and still runs the other checks', async () => {
    const result = await doctor(await project({ 'kay.config.ts': 'throw new Error(\'boom in the config\')\n' }))

    expect(result.code).toBe(1)
    expect(result.check('config').ok).toBe(false)
    expect(result.check('config').message).toContain('boom in the config')
    expect(result.checks).toHaveLength(6)
    expect(result.check('bun').ok).toBe(true)
  })

  describe('env', () => {
    const files = { 'src/env.ts': 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const env = defineEnv(s.Object({\n  DATABASE_URL: s.String(),\n  API_KEY: s.String(),\n  SESSION_SECRET: s.String({ default: \'dev\', requiredInProduction: true }),\n  PORT: s.Integer({ default: 8080 }),\n}))\n' }

    it('fails a required variable that is unset, naming it, and none that has a default or is for production', async () => {
      const result = await doctor(await project(files))

      expect(result.check('env').ok).toBe(false)
      expect(result.check('env').message).toContain('DATABASE_URL')
      expect(result.check('env').message).toContain('API_KEY')
      expect(result.check('env').message).not.toContain('SESSION_SECRET')
      expect(result.check('env').message).not.toContain('PORT')
      expect(result.check('env').fix).toContain('.env')
    })

    it('reads a variable from the shell or from the project\'s own .env files, whatever the directory it runs in', async () => {
      const root = await project({ ...files, '.env': '# a comment\r\nexport DATABASE_URL="postgres://x"\r\nno equals here\r\n=orphan\r\n', '.env.local': 'API_KEY=\n' })
      const empty = await doctor(root)

      expect(empty.check('env').message).toContain('API_KEY')
      expect(empty.check('env').message).not.toContain('DATABASE_URL')

      const shell = await doctor(root, [], { API_KEY: 'k' })

      expect(shell.check('env').ok).toBe(true)

      await Bun.write(join(root, '.env.local'), 'API_KEY=k\n')

      const elsewhere = await doctor(await scratchDir('doctor-cwd-'), [root])

      expect(elsewhere.check('env').ok).toBe(true)
    })
  })

  describe('port', () => {
    it('fails a port another process holds, naming it and the way out', async () => {
      const busy = await busyPort()

      try {
        const result = await doctor(await project(), ['--port', String(busy.port)])

        expect(result.code).toBe(1)
        expect(result.check('port').ok).toBe(false)
        expect(result.check('port').message).toContain(String(busy.port))
        expect(result.check('port').fix).toContain('--port')

        const fromEnv = await doctor(await project({ '.env': `PORT=${busy.port}\n` }))

        expect(fromEnv.check('port').ok).toBe(false)
        expect((await doctor(await project(), [], { PORT: String(busy.port) })).check('port').ok).toBe(false)
      }
      finally {
        busy.release()
      }
    })

    it('passes the port of the project\'s own kay dev, and a free one', async () => {
      const busy = await busyPort()
      const root = await project()

      try {
        await Bun.write(join(root, '.kay/dev', `server-${process.pid}.json`), JSON.stringify({ url: `http://localhost:${busy.port}`, pid: process.pid }))

        const own = await doctor(root, ['--port', String(busy.port)])

        expect(own.check('port').ok).toBe(true)
        expect(own.check('port').message).toContain('kay dev')
      }
      finally {
        busy.release()
      }

      const after = await busyPort()

      after.release()
      expect((await doctor(await project(), ['--port', String(after.port)])).check('port').ok).toBe(true)
    })

    it('fails a port that is no number', async () => {
      expect((await doctor(await project(), [], { PORT: 'http' })).check('port').ok).toBe(false)
      expect((await doctor(await project(), ['--port', '70000'])).code).toBe(1)
    })
  })

  describe('build', () => {
    const built = (stamp: object, dir = '.kay/client') => ({ [`${dir}/manifest.json`]: JSON.stringify({ entryImports: [], islands: {}, styles: {}, ...stamp }) })

    it('passes a project nothing built and a build by this kay', async () => {
      expect((await doctor(await project())).check('build').message).toContain('not built')
      expect((await doctor(await project(built({ kay: version })))).check('build').ok).toBe(true)
    })

    it('fails a build by another kay, or by one before the stamp, with the command that rebuilds it', async () => {
      const other = await doctor(await project(built({ kay: otherMinor })))

      expect(other.code).toBe(1)
      expect(other.check('build').ok).toBe(false)
      expect(other.check('build').message).toContain(otherMinor)
      expect(other.check('build').fix).toContain('kay build')

      const unstamped = await doctor(await project(built({}, '.kay/dev')))

      expect(unstamped.check('build').ok).toBe(false)
      expect(unstamped.check('build').fix).toContain('kay dev')
    })

    it('fails a manifest it cannot read rather than throwing', async () => {
      const result = await doctor(await project({ '.kay/client/manifest.json': '{ nope' }))

      expect(result.check('build').ok).toBe(false)
      expect(result.code).toBe(1)
    })
  })
})
