import { join } from 'node:path'
import process from 'node:process'
import { appCopy } from '../../../../tests/scratch'

// A copy of the fixture app, for a test that builds or checks it: another file serving the fixture meanwhile never meets the build output.
export async function fixtureCopy(): Promise<string> {
  return appCopy(join(import.meta.dir, '../fixture'), 'ai-fixture-')
}

// The environment of a `kay` command run on the copy as an app runs it: rooted there, and outside the test worker whose number would send the build to `client-<n>`.
export function appEnv(root: string): Record<string, string | undefined> {
  return { ...process.env, KAY_ROOT: root, BUN_TEST_WORKER_ID: undefined }
}
