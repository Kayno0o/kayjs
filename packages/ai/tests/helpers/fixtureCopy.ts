import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { scratchDir } from '../../../../tests/scratch'

// A copy of the fixture app in a scratch directory of its own, for a test that builds or checks it: another file serving the fixture meanwhile never meets the build output. The copy resolves the packages from the checkout's node_modules, as the fixture's own links do.
export async function fixtureCopy(): Promise<string> {
  const dir = await scratchDir('ai-fixture-')

  await cp(join(import.meta.dir, '../fixture'), dir, { recursive: true, filter: source => !source.endsWith('/.kay') && !source.endsWith('/node_modules') })

  return dir
}

// The environment of a `kay` command run on the copy as an app runs it: rooted there, and outside the test worker whose number would send the build to `client-<n>`.
export function appEnv(root: string): Record<string, string | undefined> {
  return { ...process.env, KAY_ROOT: root, BUN_TEST_WORKER_ID: undefined }
}
