import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { engines } from '../package.json'
import { bunProblem } from '../src/bun'
import { scratchDir } from './scratch'

describe('the Bun kay runs on', () => {
  it('meets the engines of kay\'s package.json, a canary counting as its release', () => {
    expect(engines.bun).toBe('>=1.4.3')
    expect(bunProblem('1.4.3', '/usr/bin/bun')).toBeUndefined()
    expect(bunProblem('1.4.4-canary.1+6c1eb067e', '/usr/bin/bun')).toBeUndefined()
    expect(bunProblem('1.4.2', '/usr/bin/bun')).toBe('kay needs Bun >=1.4.3, and runs on Bun 1.4.2 at /usr/bin/bun: run `bun upgrade`')
  })

  it('names the npm bun package a dependency installed as the one to update', () => {
    expect(bunProblem('1.4.2', '/app/node_modules/bun/bin/bun.exe')).toBe('kay needs Bun >=1.4.3, and runs on Bun 1.4.2 at /app/node_modules/bun/bin/bun.exe: a dependency installed the npm `bun` package, which package scripts run ahead of the system Bun; run `bun update bun`')
  })

  it('is refused by the CLI and by pages() under the floor', async () => {
    // A copy of kay whose floor this Bun is under.
    const dir = await scratchDir('bun-floor-')
    const manifest = await Bun.file(join(import.meta.dir, '../package.json')).json() as { engines: Record<string, string> }

    try {
      await cp(join(import.meta.dir, '../src'), join(dir, 'src'), { recursive: true })
      await Bun.write(join(dir, 'package.json'), JSON.stringify({ ...manifest, engines: { bun: '>=99.0.0' } }))
      // The fix it names depends on which Bun runs the tests, the system one or the npm package.
      const refused = `kay: kay needs Bun >=99.0.0, and runs on Bun ${Bun.version} at ${process.execPath}: `
      const run = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
        const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

        return { code, refused: stderr.startsWith(refused) && stderr.endsWith('`\n') }
      }

      expect(await run('src/cli.ts', '--help')).toEqual({ code: 1, refused: true })

      const served = await run('-e', 'import { pages } from \'./src/server/index.ts\'\ntry { await pages() } catch (error) { console.error((error as Error).message); process.exit(2) }')

      expect(served).toEqual({ code: 2, refused: true })
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
