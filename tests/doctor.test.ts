import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { version } from '../package.json'
import { manifestOf } from '../src/commands/doctor'
import { readManifest, writeManifest } from '../src/server/client'
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
async function busyPort(address = '0.0.0.0'): Promise<{ port: number, release: () => void }> {
  const server = createServer()

  await new Promise<void>(resolve => server.listen(0, address, resolve))

  return { port: (server.address() as { port: number }).port, release: () => server.close() }
}

function hasIpv6(): boolean {
  try {
    Bun.listen({ hostname: '::1', port: 0, socket: { data: () => undefined } }).stop(true)

    return true
  }
  catch {
    return false
  }
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

  it('finds a library installed above the project, as a workspace hoists it', async () => {
    const parent = await project({ ...installed('@kaynooo/kayjs', version), ...installed('@kaynooo/kayjs-hoisted', version) })
    const member = join(parent, 'app')

    await Bun.write(join(member, 'package.json'), '{ "dependencies": { "@kaynooo/kayjs": "x", "@kaynooo/kayjs-hoisted": "x" } }')

    const result = await doctor(member)

    expect(result.check('versions').ok, result.check('versions').message).toBe(true)
  })

  it('fails a listed library that is not installed, and ignores libraries it does not know', async () => {
    const missing = await doctor(await project({ 'package.json': '{ "dependencies": { "@kaynooo/kayjs-nonexistent": "x", "left-pad": "1.0.0" } }' }))

    expect(missing.check('versions').ok).toBe(false)
    expect(missing.check('versions').message).toContain('@kaynooo/kayjs-nonexistent')
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

    it('takes KAY_PROXY_KEY_FILE for the proxy key a production server with proxy.key needs', async () => {
      const root = await project({ 'kay.config.ts': 'export default { favicon: false, proxy: { key: "x-upstream-key" } }\n' })
      const production = { NODE_ENV: 'production' }

      expect((await doctor(root, [], production)).check('env').message).toContain('KAY_PROXY_KEY')
      expect((await doctor(root, [], { ...production, KAY_PROXY_KEY_FILE: '/run/secrets/key' })).check('env').ok).toBe(true)
      expect((await doctor(root, [], { ...production, KAY_PROXY_KEY: 'k' })).check('env').ok).toBe(true)
    })

    it('sees every schema of a module whose first one is unset', async () => {
      const second = 'import { s } from \'kay\'\nimport { defineEnv } from \'kay/server\'\n\nexport const first = defineEnv(s.Object({ FIRST_KEY: s.String() }))\nexport const second = defineEnv(s.Object({ SECOND_KEY: s.String() }))\n'
      const result = await doctor(await project({ 'src/env.ts': second }))

      expect(result.check('env').message).toContain('FIRST_KEY')
      expect(result.check('env').message).toContain('SECOND_KEY')
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

    it.skipIf(!hasIpv6())('refuses a port held on an IPv6 address', async () => {
      for (const address of ['::', '::1']) {
        const busy = await busyPort(address)

        try {
          const result = await doctor(await project(), ['--port', String(busy.port)])

          expect(result.check('port').ok, address).toBe(false)
        }
        finally {
          busy.release()
        }
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

    it('passes PORT 0 as the system\'s pick rather than as a free port, and the default port of the project\'s kay dev address', async () => {
      const zero = await doctor(await project(), ['--port', '0'])

      expect(zero.check('port').ok).toBe(true)
      expect(zero.check('port').message).toContain('system')

      const busy = await busyPort()
      const root = await project()

      try {
        // An address without a port holds the protocol's default, which no test can bind: the check compares it as text.
        await Bun.write(join(root, '.kay/dev', `server-${process.pid}.json`), JSON.stringify({ url: 'http://localhost', pid: process.pid }))

        expect((await doctor(root, ['--port', '80'])).check('port').message).toContain('kay dev')
        expect((await doctor(root, ['--port', String(busy.port)])).check('port').ok).toBe(false)
      }
      finally {
        busy.release()
      }
    })

    it('probes the HOST the app listens on, else localhost', async () => {
      const free = await busyPort()

      free.release()

      expect((await doctor(await project(), ['--port', String(free.port)], { HOST: '203.0.113.1' })).check('port').message).toContain('cannot be listened on')
      expect((await doctor(await project({ '.env': 'HOST=203.0.113.1\n' }), ['--port', String(free.port)])).check('port').ok).toBe(false)
      expect((await doctor(await project(), ['--port', String(free.port)])).check('port').ok).toBe(true)
    })

    it('fails a port that is no number', async () => {
      expect((await doctor(await project(), [], { PORT: 'http' })).check('port').ok).toBe(false)
      expect((await doctor(await project(), ['--port', '70000'])).code).toBe(1)
    })
  })

  describe('build', () => {
    it('has kay stamp the manifests it writes with its version', async () => {
      const root = await scratchDir('doctor-stamp-')

      dirs.push(root)
      await writeManifest(root, { entryImports: [], islands: {}, styles: {} }, join(root, '.kay/client'))
      expect((await readManifest(root, join(root, '.kay/client')))!.kay).toBe(version)
      expect((await doctor(root)).check('build').ok).toBe(true)
    })

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

    it('reads a manifest again once before it counts as unreadable, as one being written reads as half a file', async () => {
      const root = await project({ '.kay/client/manifest.json': '{ "entryIm' })
      const manifest = join(root, '.kay/client/manifest.json')
      let waits = 0
      const found = await manifestOf(root, '.kay/client', async () => {
        waits++
        await Bun.write(manifest, JSON.stringify({ entryImports: [], islands: {}, styles: {}, kay: version }))
      })

      expect(waits).toBe(1)
      expect(found?.kay).toBe(version)

      await Bun.write(manifest, '{ nope')
      await expect(manifestOf(root, '.kay/client', async () => undefined)).rejects.toThrow()
    })

    it('fails a manifest it cannot read rather than throwing', async () => {
      const result = await doctor(await project({ '.kay/client/manifest.json': '{ nope' }))

      expect(result.check('build').ok).toBe(false)
      expect(result.code).toBe(1)
    })
  })
})
