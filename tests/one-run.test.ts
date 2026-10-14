import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'

// Polls for what another process makes true, failing past 10 seconds.
async function until(holds: () => boolean | Promise<boolean>): Promise<void> {
  for (let start = Date.now(); !await holds();) {
    if (Date.now() - start > 10_000)
      throw new Error('timed out')

    await Bun.sleep(10)
  }
}

// The text of a file, empty before it exists.
async function written(path: string): Promise<string> {
  const file = Bun.file(path)

  return await file.exists() ? file.text() : ''
}

// What a stream has written so far, read as it comes.
function collected(stream: ReadableStream<Uint8Array>): { text: () => string, done: Promise<void> } {
  let text = ''
  const done = (async () => {
    for await (const chunk of stream)
      text += new TextDecoder().decode(chunk)
  })()

  return { text: () => text, done }
}

describe('the test run lock', () => {
  // A checkout of its own, whose tests note when they start, then wait for the `gate` file the test writes, and note when they end.
  async function checkout(files = ['slow']) {
    const root = await mkdtemp(join(tmpdir(), 'kay-one-run-'))

    await Bun.write(join(root, 'bunfig.toml'), '[test]\nroot = "./tests"\npreload = ["./tests/one-run.ts"]\n')
    await Bun.write(join(root, 'tests/one-run.ts'), Bun.file(join(import.meta.dir, 'one-run.ts')))
    await Promise.all(files.map(async file => Bun.write(join(root, `tests/${file}.test.ts`), 'import { appendFileSync, existsSync } from \'node:fs\'\nimport { it } from \'bun:test\'\n\nit(\'runs\', async () => {\n  appendFileSync(\'runs.log\', `start ${process.env.RUN}\\n`)\n  while (!existsSync(\'gate\'))\n    await Bun.sleep(5)\n  appendFileSync(\'runs.log\', `end ${process.env.RUN}\\n`)\n})\n')))

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

      await until(async () => Bun.file(join(root, 'runs.log')).exists())

      const second = run(root, 'b')
      const stderr = collected(second.stderr)

      // The first holds the run until the second has said it waits.
      await until(() => stderr.text().includes('kay tests: waiting for the run of process'))
      await Bun.write(join(root, 'gate'), '')
      await Promise.all([first.exited, stderr.done, second.exited])

      const waited = stderr.text()

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
      const parallel = run(root, 'a', '--parallel=2')

      // Both workers start before either ends, so neither waited for the other.
      await until(async () => (await written(join(root, 'runs.log'))) === 'start a\nstart a\n')
      await Bun.write(join(root, 'gate'), '')
      expect(await parallel.exited).toBe(0)
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
      await Bun.write(join(root, 'gate'), '')
      expect(await run(root, 'a', '--parallel').exited).toBe(0)
      expect(await Bun.file(join(root, '.kay/test-run.lock')).exists()).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
