import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll } from 'bun:test'

// The suite builds into this checkout's `.kay/client` and prerenders over it, so two runs at once, as from two terminals or sessions, break each other's tests: a second run waits for the first.
const LOCK = join(import.meta.dir, '..', '.kay', 'test-run.lock')
const OWNER = join(LOCK, 'pid')
// Passed on to the `bun test` runs the suite spawns itself, which must not wait for their parent.
const HELD = 'KAY_TEST_RUN_LOCK'

function holder(): number | undefined {
  try {
    const pid = Number(readFileSync(OWNER, 'utf8'))

    process.kill(pid, 0)

    return pid
  }
  catch {
    return undefined
  }
}

if (process.env[HELD] === undefined) {
  mkdirSync(join(LOCK, '..'), { recursive: true })

  for (let told = false; ;) {
    try {
      mkdirSync(LOCK)

      break
    }
    catch {}

    const pid = holder()

    // A run that died without letting go, or one that has not written its pid yet.
    if (pid === undefined) {
      await Bun.sleep(200)

      if (holder() === undefined)
        rmSync(LOCK, { recursive: true, force: true })

      continue
    }

    if (!told) {
      console.error(`kay tests: waiting for the run of process ${pid} in this checkout to finish`)
      told = true
    }

    await Bun.sleep(500)
  }

  writeFileSync(OWNER, String(process.pid))
  process.env[HELD] = String(process.pid)
  // `bun test` runs no `exit` listener, and a run stopped short leaves the lock to the next one, which finds its process gone.
  afterAll(() => rmSync(LOCK, { recursive: true, force: true }))
}
