import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { KAY_DIR, testWorker } from '../build/assets'
import { alive } from '../server/lifecycle'

const FILE = /^server-(\d+)\.json$/

function devDirectory(root: string): string {
  return join(root, KAY_DIR, `dev${testWorker()}`)
}

// Where `kay dev` says which address it serves on, for what runs beside it, such as `kay screenshot`: a file per `kay dev` process, so two of one project each keep theirs.
export function devAddressFile(root: string, pid = process.pid): string {
  return join(devDirectory(root), `server-${pid}.json`)
}

// Written once a server listens and again when a restart moves the address; the pid is the `kay dev` process, which a reader checks to ignore a file a killed one left.
export function writeDevAddress(root: string, url: string): void {
  const file = devAddressFile(root)
  const partial = `${file}.tmp`

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(partial, `${JSON.stringify({ url, pid: process.pid })}\n`)
    renameSync(partial, file)
  }
  // A directory removed under it costs `kay screenshot` its address, never the server its start.
  catch {}
}

// Removes this process's own file, which another `kay dev` of the project leaves alone.
export function removeDevAddress(root: string): void {
  rmSync(devAddressFile(root), { force: true })
}

// The address of the `kay dev` of the project that wrote its file last and still runs, or nothing when none does: no file, one left by a dead process, or one that is no http address.
export function readDevAddress(root: string): string | undefined {
  const dir = devDirectory(root)
  let names: string[]

  try {
    names = readdirSync(dir)
  }
  catch {
    return undefined
  }

  const running: { url: string, time: number }[] = []

  for (const name of names) {
    const pid = FILE.exec(name)?.[1]

    if (pid === undefined)
      continue

    try {
      const file = join(dir, name)
      const { url } = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown }

      if (typeof url !== 'string' || !['http:', 'https:'].includes(new URL(url).protocol))
        continue

      const stat = statSync(file, { throwIfNoEntry: false })

      if (stat === undefined)
        continue

      if (alive(Number(pid)))
        running.push({ url, time: stat.mtimeMs })
      else
        rmSync(file, { force: true })
    }
    catch {}
  }

  return running.toSorted((a, b) => b.time - a.time)[0]?.url
}
