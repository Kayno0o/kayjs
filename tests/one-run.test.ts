import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'

describe('the test run lock', () => {
  // A checkout of its own, whose tests note when they start and end.
  async function checkout(files = ['slow']) {
    const root = await mkdtemp(join(tmpdir(), 'kay-one-run-'))

    await Bun.write(join(root, 'bunfig.toml'), '[test]\nroot = "./tests"\npreload = ["./tests/one-run.ts"]\n')
    await Bun.write(join(root, 'tests/one-run.ts'), Bun.file(join(import.meta.dir, 'one-run.ts')))
    await Promise.all(files.map(async file => Bun.write(join(root, `tests/${file}.test.ts`), 'import { appendFileSync } from \'node:fs\'\nimport { it } from \'bun:test\'\n\nit(\'runs\', async () => {\n  appendFileSync(\'runs.log\', `start ${process.env.RUN}\\n`)\n  await Bun.sleep(800)\n  appendFileSync(\'runs.log\', `end ${process.env.RUN}\\n`)\n})\n')))

    return root
  }

  const run = (root: string, name: string, ...flags: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, RUN: name }

    delete env.KAY_TEST_RUN_LOCK
    delete env.BUN_TEST_WORKER_ID

    return Bun.spawn([process.execPath, 'test', ...flags], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
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

  it('lets the workers of a parallel run share the lock, which the next run takes once the parallel one is gone', async () => {
    const root = await checkout(['slow', 'other'])

    try {
      expect(await run(root, 'a', '--parallel=2').exited).toBe(0)
      expect(await Bun.file(join(root, 'runs.log')).text()).toBe('start a\nstart a\nend a\nend a\n')

      await Bun.write(join(root, 'runs.log'), '')
      const next = run(root, 'b')
      const [waited] = await Promise.all([new Response(next.stderr).text(), next.exited])

      expect(waited).not.toContain('kay tests: waiting')
      expect(await Bun.file(join(root, 'runs.log')).text()).toBe('start b\nend b\nstart b\nend b\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves no lock behind a parallel run of one file, which runs in the run\'s own process', async () => {
    const root = await checkout()

    try {
      expect(await run(root, 'a', '--parallel').exited).toBe(0)
      expect(await Bun.file(join(root, '.kay/test-run.lock')).exists()).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
