import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { KAY_DIR, testWorker } from '../build/assets'
import { alive } from '../server/lifecycle'

const FILE = 'server.json'

// Where `kay dev` says which address it serves on, for what runs beside it, such as `kay screenshot`.
export function devAddressFile(root: string): string {
  return join(root, KAY_DIR, `dev${testWorker()}`, FILE)
}

// Written once a server listens and again when a restart moves the address; the pid is the `kay dev` process, which a reader checks to ignore a file a killed one left.
export function writeDevAddress(root: string, url: string): void {
  const file = devAddressFile(root)
  const partial = `${file}.${process.pid}`

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(partial, `${JSON.stringify({ url, pid: process.pid })}\n`)
    renameSync(partial, file)
  }
  // A directory removed under it costs `kay screenshot` its address, never the server its start.
  catch {}
}

// Removes the file when it is this process's own: another `kay dev` of the project may have taken it over.
export function removeDevAddress(root: string): void {
  const file = devAddressFile(root)

  try {
    if ((JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid === process.pid)
      rmSync(file, { force: true })
  }
  catch {}
}

// The address a `kay dev` of the project serves on, or nothing when none runs: no file, one left by a dead process, or one that is no http address.
export function readDevAddress(root: string): string | undefined {
  try {
    const { url, pid } = JSON.parse(readFileSync(devAddressFile(root), 'utf8')) as { url?: unknown, pid?: unknown }

    if (typeof url !== 'string' || typeof pid !== 'number' || !alive(pid) || !['http:', 'https:'].includes(new URL(url).protocol))
      return undefined

    return url
  }
  catch {
    return undefined
  }
}
