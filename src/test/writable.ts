import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

// The islands a test site builds go into `.kay`, so one that cannot be written fails here with the way out rather than as the EACCES of whichever file comes first.
export function assertKayWritable(root: string): void {
  const folder = join(root, '.kay')

  try {
    mkdirSync(folder, { recursive: true })
    // A real write: `access` says yes to root on a read-only mount.
    const probe = join(folder, `.writable-${process.pid}`)

    writeFileSync(probe, '')
    rmSync(probe)
  }
  catch {
    throw new Error(`kay: testSite() builds the islands into ${folder}, which cannot be written; make it writable (a bind mount or a read-only checkout needs a writable .kay), or pass \`islands: false\` for a site whose tests need no built islands`)
  }
}
