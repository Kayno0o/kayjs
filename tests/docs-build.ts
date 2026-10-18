import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const LOCK = join(import.meta.dir, '../docs/.kay/build.lock')
const HOLDER = join(LOCK, 'pid')

// A lock whose holder is no longer running belongs to a test that died; one still running keeps it however long its build takes.
async function heldByTheDead(): Promise<boolean> {
  let pid: number

  try {
    pid = Number(await readFile(HOLDER, 'utf8'))
  }
  catch {
    // Taken an instant ago, its pid not written yet, unless its holder died in between.
    try {
      return Date.now() - (await stat(LOCK)).mtimeMs > 10_000
    }
    catch {
      return false
    }
  }

  try {
    process.kill(pid, 0)

    return false
  }
  catch {
    return true
  }
}

// Tests of one parallel run each build the docs into `docs/.kay` and read or serve it: one at a time, as a build wipes the last one. Returns what releases the turn.
export async function takeDocsBuild(): Promise<() => Promise<void>> {
  await mkdir(join(LOCK, '..'), { recursive: true })

  for (;;) {
    try {
      await mkdir(LOCK)
      await writeFile(HOLDER, String(process.pid))

      return async () => rm(LOCK, { recursive: true, force: true })
    }
    catch {
      if (await heldByTheDead())
        await rm(LOCK, { recursive: true, force: true })

      await Bun.sleep(200)
    }
  }
}
