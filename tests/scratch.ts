import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { scratchDir as projectScratch } from '../src/test/scratch'
import { kayTypes } from './kay-types'
import { made } from './scratch-track'

// The checkout, which scratch directories go under as `.kay/scratch`: inside it, so a file a test writes there imports kay and the packages as the fixtures do, and two levels down, as a fixture is, so a copy's relative imports still reach the checkout.
const CHECKOUT = join(import.meta.dir, '..')
const SCRATCH = join(CHECKOUT, '.kay', 'scratch')

// A fresh directory of its own, its absolute path, removed once the process's tests ran (tests/scratch-track.ts).
export async function scratchDir(prefix: string): Promise<string> {
  const dir = await projectScratch(prefix, CHECKOUT)

  made.add(dir)

  return dir
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
  await typedFromDeclarations(dir)

  return relative(process.cwd(), dir)
}

// A copy's checks type `kay` from its declarations (tests/kay-types.ts), its own `paths` kept; a tsconfig that is not plain JSON is left as it is.
async function typedFromDeclarations(dir: string): Promise<void> {
  const file = join(dir, 'tsconfig.json')
  let config: { compilerOptions?: { paths?: Record<string, string[]> } }

  try {
    config = JSON.parse(await readFile(file, 'utf8')) as typeof config
  }
  catch {
    return
  }

  config.compilerOptions = { ...config.compilerOptions, paths: { ...kayTypes(), ...config.compilerOptions?.paths } }
  await writeFile(file, JSON.stringify(config, null, 2))
}

// A copy of an app outside `tests/fixtures`, as a library's fixture is, for a test that builds or writes into it, its build output and installs left out: the copy resolves the packages from the checkout's node_modules. Its absolute path.
export async function appCopy(app: string, prefix: string): Promise<string> {
  const dir = await scratchDir(prefix)

  await cp(app, dir, { recursive: true, filter: source => !source.endsWith('/.kay') && !source.endsWith('/node_modules') })
  await typedFromDeclarations(dir)

  return dir
}
