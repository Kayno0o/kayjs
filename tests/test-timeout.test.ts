import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const PRELOAD = join(import.meta.dir, '..', 'src', 'test', 'preload.ts')
// Past Bun's 5 s default for a hook, short of kay's.
const HOOK_MS = 5500

// Runs a test file whose afterAll takes `HOOK_MS`, in a project preloading kay/test/preload with the given bunfig lines under [test].
async function run(config: string): Promise<{ code: number, report: string }> {
  const dir = await scratchDir('timeout-')

  await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n${config}\n`)
  await Bun.write(join(dir, 'slow.test.ts'), `import { afterAll, it } from 'bun:test'\nafterAll(async () => { await Bun.sleep(${HOOK_MS}) })\nit('passes', () => {})\n`)

  const child = Bun.spawn([process.execPath, 'test'], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: undefined } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

describe('kay/test/preload\'s timeout', () => {
  it('lets a hook take longer than Bun\'s 5 s default, which a busy machine needs to drop a database or stop a server', async () => {
    const { code, report } = await run('')

    expect(report).not.toContain('timed out')
    expect(code).toBe(0)
  }, 30_000)

  it('leaves the timeout a project chose in its bunfig.toml', async () => {
    const chosen = await run('timeout = 2000')

    // Bun's [test] timeout does not reach hooks, so a project that set one keeps Bun's hook default.
    expect(chosen.report).toContain('timed out')
  }, 30_000)
})
