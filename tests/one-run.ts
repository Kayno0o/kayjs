import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll } from 'bun:test'

// The suite builds into this checkout's `.kay` and its fixtures', and prerenders over them, so two runs at once, as from two terminals or sessions, break each other's tests: a second run waits for the first.
const DIR = join(import.meta.dir, '..', '.kay')
const LOCK = join(DIR, 'test-run.lock')
// Passed on to the `bun test` runs the suite spawns itself, which must not wait for their parent.
const HELD = 'KAY_TEST_RUN_LOCK'
const AFTER_NAME = /\)\s(.*)$/s

// A pid and its start time, so a pid the system gave again to another process reads as a run gone. The start time is Linux's, empty elsewhere.
function identity(pid: number): string {
  try {
    return `${pid} ${AFTER_NAME.exec(readFileSync(`/proc/${pid}/stat`, 'utf8'))?.[1]?.split(' ')[19] ?? ''}`
  }
  catch {
    return `${pid} `
  }
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return undefined
  }
}

// Every identity holds a space, after the pid.
function pidOf(held: string): string {
  return held.slice(0, held.indexOf(' '))
}

function running(held: string): boolean {
  const pid = Number(pidOf(held))

  if (!Number.isInteger(pid) || pid <= 0)
    return false

  try {
    process.kill(pid, 0)
  }
  catch {
    return false
  }

  return identity(pid) === held
}

// Written whole under another name and linked into place, so the lock never exists without its holder in it.
function take(own: string): boolean {
  const draft = join(DIR, `test-run.${process.pid}`)

  writeFileSync(draft, own)

  try {
    linkSync(draft, LOCK)

    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error

    return false
  }
  finally {
    rmSync(draft, { force: true })
  }
}

// Moved aside before it is read again, so of two runs finding it stale only one removes it, and a lock taken meanwhile goes back.
function clearStale(stale: string) {
  const aside = join(DIR, `test-run.stale.${process.pid}`)

  try {
    renameSync(LOCK, aside)
  }
  catch {
    return
  }

  if (read(aside) !== stale) {
    try {
      linkSync(aside, LOCK)
    }
    catch {}
  }

  rmSync(aside, { force: true })
}

if (process.env[HELD] === undefined) {
  // Under `bun test --parallel` the run is the parent process, whose workers all share the lock the first of them took; a run of one file stays in that process, which sets BUN_TEST_WORKER_ID all the same.
  const worker = read('/proc/self/cmdline')?.split('\0').includes('--test-worker') ?? process.env.BUN_TEST_WORKER_ID !== undefined
  const own = identity(worker ? process.ppid : process.pid)
  let told = false

  mkdirSync(DIR, { recursive: true })

  // The directory an earlier version of this lock was.
  if (statSync(LOCK, { throwIfNoEntry: false })?.isDirectory())
    rmSync(LOCK, { recursive: true, force: true })

  while (!take(own)) {
    const held = read(LOCK)

    if (held === own)
      break

    if (held !== undefined && !running(held)) {
      clearStale(held)

      continue
    }

    if (!told && held !== undefined) {
      console.error(`kay tests: waiting for the run of process ${pidOf(held)} in this checkout to finish (${LOCK})`)
      told = true
    }

    await Bun.sleep(500)
  }

  process.env[HELD] = String(process.pid)

  // `bun test` runs no `exit` listener, and a run stopped short leaves the lock to the next one, which finds its process gone; so does a parallel run, as no worker knows it ends last.
  if (!worker) {
    afterAll(() => {
      if (read(LOCK) === own)
        rmSync(LOCK, { force: true })
    })
  }
}
