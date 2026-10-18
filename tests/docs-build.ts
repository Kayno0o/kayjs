import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const LOCK = join(import.meta.dir, '../docs/.kay/build.lock')
// A lock older than this belongs to a test that died.
const STALE_MS = 5 * 60_000

async function modifiedAgo(): Promise<number> {
  try {
    return Date.now() - (await stat(LOCK)).mtimeMs
  }
  catch {
    return 0
  }
}

// Tests of one parallel run each build the docs into `docs/.kay` and read or serve it: one at a time, as a build wipes the last one. Returns what releases the turn.
export async function takeDocsBuild(): Promise<() => Promise<void>> {
  await mkdir(join(LOCK, '..'), { recursive: true })

  for (;;) {
    try {
      await mkdir(LOCK)

      return async () => rm(LOCK, { recursive: true, force: true })
    }
    catch {
      const age = await modifiedAgo()

      if (age > STALE_MS)
        await rm(LOCK, { recursive: true, force: true })

      await Bun.sleep(200)
    }
  }
}
