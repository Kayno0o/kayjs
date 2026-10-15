import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
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
// `stable` puts it at the same path every run, for a test measuring a build: Bun hashes chunk names from their sources' paths, so a random directory name moves the gzip size by several bytes.
// Only one test file may take a stable name, as two running together would share the directory.
export async function fixtureCopy(name: string, stable = false): Promise<string> {
  const dir = stable ? join(SCRATCH, `${name}-stable`) : await scratchDir(`${name}-`)

  if (stable) {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
  }

  await cp(join(import.meta.dir, 'fixtures', name), dir, { recursive: true, filter: source => !source.endsWith('/.kay') })

  return relative(process.cwd(), dir)
}
