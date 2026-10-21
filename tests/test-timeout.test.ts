import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const PRELOAD = join(import.meta.dir, '..', 'src', 'test', 'preload.ts')
// Past Bun's 5 s default for a hook, short of kay's.
const HOOK_MS = 5500
// Past the 2 s a project chose, which needs no wait near Bun's default.
const SHORT_HOOK_MS = 2500

// Runs a test file whose afterAll takes `hook` ms, in a project preloading kay/test/preload with the given bunfig lines under [test].
async function run(config: string, args: string[] = [], hook = HOOK_MS): Promise<{ code: number, report: string }> {
  const dir = await scratchDir('timeout-')

  // The project kay serves may sit elsewhere than the working directory, where Bun reads the bunfig.
  await Bun.write(join(dir, 'app', 'kay.config.ts'), 'export default {}\n')
  await Bun.write(join(dir, 'bunfig.toml'), `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n${config}\n`)
  await Bun.write(join(dir, 'slow.test.ts'), `import { afterAll, it } from 'bun:test'\nafterAll(async () => { await Bun.sleep(${hook}) })\nit('passes', () => {})\n`)

  const child = Bun.spawn([process.execPath, 'test', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, KAY_ROOT: join(dir, 'app') } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { code, report: out + err }
}

// The four runs wait on a sleeping hook each, so they go side by side.
const runs = {
  default: run(''),
  chosen: run('timeout = 2000', [], SHORT_HOOK_MS),
  flagged: run('', ['--timeout', '2000'], SHORT_HOOK_MS),
  longer: run('timeout = 9000'),
}

describe('kay/test/preload\'s timeout', () => {
  it('lets a hook take longer than Bun\'s 5 s default, which a busy machine needs to drop a database or stop a server', async () => {
    const { code, report } = await runs.default

    expect(report).not.toContain('timed out')
    expect(code).toBe(0)
  }, 30_000)

  it('gives hooks the timeout a project chose in its bunfig.toml or with --timeout, which Bun does not do itself', async () => {
    const { chosen, flagged, longer } = { chosen: await runs.chosen, flagged: await runs.flagged, longer: await runs.longer }

    expect(chosen.report).toContain('timed out')
    expect(flagged.report).toContain('timed out')
    expect(longer.report).not.toContain('timed out')
  }, 60_000)
})
