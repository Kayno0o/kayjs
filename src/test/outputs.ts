import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { KAY_DIR } from '../build/assets'

// Decisions: a check build's output folder is named by its options key, so options that change per run (a random port, a temp root) leave one folder each. A folder not used for a day is removed; every use touches its mtime, so a folder a live worker of `bun test --parallel` still builds into or reads is never a day old, whichever worker prunes. A process whose build stays cached (`bun test --watch`) touches its folder on each cache hit older than an hour. Pruning runs once per root and process, and a race with a worker starting on a folder just past the day only rebuilds it.
export const STALE_OUTPUT_MS = 24 * 60 * 60 * 1000
const TOUCH_AFTER_MS = 60 * 60 * 1000
const TEST_OUTPUT = /^test-client(?:-\d+)?\.[0-9a-z]+$/
const prunedRoots = new Set<string>()

export function touchOutput(root: string, output: string): void {
  try {
    const now = new Date()

    utimesSync(join(root, KAY_DIR, output), now, now)
  }
  catch {}
}

// The cache-hit path: cheap, as it is one stat while the folder is recent.
export function touchOutputIfOld(root: string, output: string): void {
  try {
    const used = statSync(join(root, KAY_DIR, output), { throwIfNoEntry: false })

    if (used !== undefined && Date.now() - used.mtimeMs >= TOUCH_AFTER_MS)
      touchOutput(root, output)
  }
  catch {}
}

export function pruneTestOutputs(root: string, keep: string, force = false): void {
  if (!force && prunedRoots.has(root))
    return

  prunedRoots.add(root)

  try {
    const dir = join(root, KAY_DIR)

    for (const name of readdirSync(dir)) {
      if (name === keep || !TEST_OUTPUT.test(name))
        continue

      // Gone already when another worker pruned it first.
      const used = statSync(join(dir, name), { throwIfNoEntry: false })

      if (used === undefined || Date.now() - used.mtimeMs < STALE_OUTPUT_MS)
        continue

      rmSync(join(dir, name), { recursive: true, force: true })
    }
  }
  catch {}
}
