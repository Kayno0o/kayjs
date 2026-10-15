import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'

// A fresh directory of its own under the project's `.kay/scratch`, its absolute path: inside the project, so a file written there imports the project's packages, and under `.kay`, which no build or check scans, so another test file building beside it never meets it.
export async function scratchDir(prefix = 'scratch-', root = process.cwd()): Promise<string> {
  const scratch = join(resolve(root), '.kay', 'scratch')

  await mkdir(scratch, { recursive: true })

  return mkdtemp(join(scratch, prefix))
}
