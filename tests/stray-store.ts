import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { afterAll, beforeAll } from 'bun:test'

// Not imported from the server, as every test file loads this preload.
const NOT_FOUND_FILE = 'data/not-found.sqlite'

// A production server a test builds counts its 404s in `data/not-found.sqlite` of the working folder unless the app's store names a file: a file that leaves it behind fails and the file is removed, as the next landing refuses a checkout with an untracked file. Such a test serves with `store: await scratchStore()` (tests/helpers/scratch-store.ts).
let kept = false
let folder = false

beforeAll(() => {
  kept = existsSync(NOT_FOUND_FILE)
  folder = existsSync('data')
})

afterAll(async () => {
  if (kept || !existsSync(NOT_FOUND_FILE))
    return

  // SQLite's journal files go with it, and the folder when the file made it.
  await Promise.all(['', '-wal', '-shm'].map(async suffix => rm(`${NOT_FOUND_FILE}${suffix}`, { force: true })))

  if (!folder && readdirSync('data').length === 0)
    await rm('data', { recursive: true, force: true })

  throw new Error(`this file left ${NOT_FOUND_FILE} in the working folder (removed now): serve with \`store: await scratchStore()\` from tests/helpers/scratch-store.ts`)
})
