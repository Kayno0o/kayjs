import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { scratchDir } from '../../../../tests/scratch'

// A copy of the fixture app in a scratch directory of its own, for a test that writes under the app's `.kay`: a file serving the fixture meanwhile never meets what it wrote. The copy resolves the packages from the checkout's node_modules, as the fixture's own links do.
export async function fixtureCopy(): Promise<string> {
  const dir = await scratchDir('mail-fixture-')

  await cp(join(import.meta.dir, '../fixture'), dir, { recursive: true, filter: source => !source.endsWith('/.kay') && !source.endsWith('/node_modules') })

  return dir
}
