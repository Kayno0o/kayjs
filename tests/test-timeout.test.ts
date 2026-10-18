import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const PRELOAD = join(import.meta.dir, '..', 'src', 'test', 'preload.ts')
// Past Bun's 5 s default for a hook, short of kay's.
const HOOK_MS = 5500

// Runs a test file whose afterAll takes `HOOK_MS`, in a project preloading kay/test/preload with the given bunfig lines under [test].
async function run(config: string, args: string[] = []): Promise<{ code: number, report: string }> {
  const dir = await scratchDir('timeout-')

  // The project kay serves may sit elsewhere than the working directory, where Bun reads the bunfig.
  await Bun.write(join(dir, 'app', 'kay.config.ts'), 'export default {}\n')
  await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n${config}\n`)
  await Bun.write(join(dir, 'slow.test.ts'), `import { afterAll, it } from 'bun:test'\nafterAll(async () => { await Bun.sleep(${HOOK_MS}) })\nit('passes', () => {})\n`)

  const child = Bun.spawn([process.execPath, 'test', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: join(dir, 'app') } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

describe('kay/test/preload\'s timeout', () => {
  it('lets a hook take longer than Bun\'s 5 s default, which a busy machine needs to drop a database or stop a server', async () => {
    const { code, report } = await run('')

    expect(report).not.toContain('timed out')
    expect(code).toBe(0)
  }, 30_000)

  it('gives hooks the timeout a project chose in its bunfig.toml or with --timeout, which Bun does not do itself', async () => {
    const chosen = await run('timeout = 2000')
    const flagged = await run('', ['--timeout', '2000'])
    const longer = await run('timeout = 9000')

    expect(chosen.report).toContain('timed out')
    expect(flagged.report).toContain('timed out')
    expect(longer.report).not.toContain('timed out')
  }, 60_000)
})
