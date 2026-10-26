import { accessSync, constants, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// The islands a test site builds go into `.kay`, so one that cannot be written fails here with the way out rather than as the EACCES of whichever file comes first.
export function assertKayWritable(root: string): void {
  const folder = join(root, '.kay')

  try {
    mkdirSync(folder, { recursive: true })
    accessSync(folder, constants.W_OK)
  }
  catch {
    throw new Error(`kay: testSite() builds the islands into ${folder}, which cannot be written; make it writable (a bind mount or a read-only checkout needs a writable .kay), or pass \`islands: false\` for a site whose tests need no built islands`)
  }
}
