import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'

describe('the test run lock', () => {
  // A checkout of its own, whose one test notes when it starts and ends.
  async function checkout() {
    const root = await mkdtemp(join(tmpdir(), 'kay-one-run-'))

    await Bun.write(join(root, 'bunfig.toml'), '[test]\nroot = "./tests"\npreload = ["./tests/one-run.ts"]\n')
    await Bun.write(join(root, 'tests/one-run.ts'), Bun.file(join(import.meta.dir, 'one-run.ts')))
    await Bun.write(join(root, 'tests/slow.test.ts'), 'import { appendFileSync } from \'node:fs\'\nimport { it } from \'bun:test\'\n\nit(\'runs\', async () => {\n  appendFileSync(\'runs.log\', `start ${process.env.RUN}\\n`)\n  await Bun.sleep(800)\n  appendFileSync(\'runs.log\', `end ${process.env.RUN}\\n`)\n})\n')

    return root
  }

  const run = (root: string, name: string) => {
    const env: Record<string, string | undefined> = { ...process.env, RUN: name }

    delete env.KAY_TEST_RUN_LOCK

    return Bun.spawn([process.execPath, 'test'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  }

  it('runs a second suite in a checkout once the first is done, and takes a lock its holder left behind', async () => {
    const root = await checkout()

    try {
      const first = run(root, 'a')

      for (let start = Date.now(); !(await Bun.file(join(root, 'runs.log')).exists()) && Date.now() - start < 10_000;)
        await Bun.sleep(20)

      const second = run(root, 'b')
      const [, waited] = await Promise.all([first.exited, new Response(second.stderr).text(), second.exited])

      expect(await Bun.file(join(root, 'runs.log')).text()).toBe('start a\nend a\nstart b\nend b\n')
      expect(waited).toContain('kay tests: waiting for the run of process')
      expect(await Bun.file(join(root, '.kay/test-run.lock')).exists()).toBe(false)

      // A pid no process has, as after a run killed outright.
      await Bun.write(join(root, '.kay/test-run.lock'), '2147483646 0')
      await Bun.write(join(root, 'runs.log'), '')
      expect(await run(root, 'c').exited).toBe(0)
      expect(await Bun.file(join(root, 'runs.log')).text()).toBe('start c\nend c\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
