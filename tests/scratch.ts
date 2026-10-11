import { cp, mkdir, mkdtemp } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'

// Under `.kay`, which no build or check of the checkout scans, so a file a test writes there never reaches another test file building beside it under `bun test --parallel`; inside the checkout, so it imports kay and the packages as the fixtures do, and two levels down, as a fixture is, so a copy's relative imports still reach the checkout.
const SCRATCH = join(import.meta.dir, '..', '.kay', 'scratch')

// A fresh directory of its own, its absolute path.
export async function scratchDir(prefix: string): Promise<string> {
  await mkdir(SCRATCH, { recursive: true })

  return mkdtemp(join(SCRATCH, prefix))
}

// A copy of `tests/fixtures/<name>`, for a test that changes its files, by its path from the working directory as fixtures are named.
export async function fixtureCopy(name: string): Promise<string> {
  const dir = await scratchDir(`${name}-`)

  await cp(join(import.meta.dir, 'fixtures', name), dir, { recursive: true, filter: source => !source.endsWith('/.kay') })

  return relative(process.cwd(), dir)
}
