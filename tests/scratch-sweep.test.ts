import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { startedAt, sweepScratch } from './scratch-sweep'

describe('the scratch sweep', () => {
  it('removes what an earlier run left and keeps what the current run made', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'kay-sweep-'))
    const began = Date.now() - 60_000
    const old = new Date(began - 3_600_000)

    try {
      for (const name of ['old-a', 'old-b']) {
        await mkdir(join(scratch, name, 'deep'), { recursive: true })
        await writeFile(join(scratch, name, 'deep', 'file.txt'), 'x')
        await utimes(join(scratch, name, 'deep', 'file.txt'), old, old)
        await utimes(join(scratch, name, 'deep'), old, old)
      }

      await mkdir(join(scratch, 'live'))

      // ctime cannot be set, so the old entries are told apart by the start time given instead.
      expect(await sweepScratch(scratch, Date.now() + 1000)).toBe(3)
      expect(existsSync(join(scratch, 'old-a'))).toBe(false)

      await mkdir(join(scratch, 'live'))
      expect(await sweepScratch(scratch, Date.now() - 60_000)).toBe(0)
      expect(existsSync(join(scratch, 'live'))).toBe(true)
    }
    finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('does nothing for a folder that does not exist', async () => {
    expect(await sweepScratch(join(tmpdir(), 'kay-sweep-missing'), Date.now())).toBe(0)
  })

  it('removes the directories a test made through scratchDir once the process ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-track-'))

    try {
      await Bun.write(join(root, 'bunfig.toml'), '[test]\npreload = ["./track.ts"]\n')
      await Bun.write(join(root, 'track.ts'), Bun.file(join(import.meta.dir, 'scratch-track.ts')))
      await Bun.write(join(root, 'a.test.ts'), `import { mkdirSync, writeFileSync } from 'node:fs'
import { it } from 'bun:test'
import { made } from './track'

it('makes', () => {
  mkdirSync('made')
  made.add(\`\${process.cwd()}/made\`)
  writeFileSync('made/x', '')
})\n`)

      const run = Bun.spawn([process.execPath, 'test', 'a.test.ts'], { cwd: root, stdout: 'ignore', stderr: 'ignore' })

      expect(await run.exited).toBe(0)
      expect(existsSync(join(root, 'made'))).toBe(false)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the start of a process before now, and a directory made by this run is past it', async () => {
    const began = startedAt(process.pid)

    if (began === undefined)
      return

    expect(began).toBeLessThan(Date.now())

    const scratch = await mkdtemp(join(tmpdir(), 'kay-sweep-'))

    try {
      await mkdir(join(scratch, 'live'))
      expect(await sweepScratch(scratch, began)).toBe(0)
      expect(existsSync(join(scratch, 'live'))).toBe(true)
    }
    finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})
