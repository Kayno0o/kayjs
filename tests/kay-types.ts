import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

const ROOT = join(import.meta.dir, '..')
// Inside the checkout, so the declarations resolve kay's dependencies from its node_modules, and where `bun pm pack` never looks.
const CACHE = join(ROOT, 'node_modules/.cache/kay-types')
const KEPT_MS = 24 * 60 * 60 * 1000
const SOURCE = /\.tsx?$/

let built: Record<string, string[]> | undefined

// What decides the declarations: the sources, the configs they build with, the dependencies they read types from and Bun, whose tsgo emits them.
function sourceKey(): string {
  const hasher = new Bun.CryptoHasher('sha1')

  hasher.update(Bun.version)

  for (const file of ['package.json', 'bun.lock', 'tsconfig.base.json', 'tsconfig.json', 'tsconfig.build.json'])
    hasher.update(`\0${file}\0`).update(readFileSync(join(ROOT, file)))

  const sources = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && SOURCE.test(entry.name)).map(entry => join(entry.parentPath, entry.name)).sort()

  for (const file of sources)
    hasher.update(`\0${relative(ROOT, file)}\0`).update(readFileSync(file))

  return hasher.digest('hex').slice(0, 16)
}

// Builds into a directory of this process's own, then moves it in place, so a reader never sees half a build; a worker that lost the race drops its copy.
function buildDeclarations(dir: string): void {
  const building = `${dir}.${process.pid}`

  mkdirSync(CACHE, { recursive: true })

  // Type errors in the sources still emit their declarations, so only a missing entry fails.
  const { stderr } = Bun.spawnSync([process.execPath, join(ROOT, 'src/tsgo.ts'), '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', building], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, NODE_ENV: undefined } })

  if (!existsSync(join(building, 'runtime/index.d.ts')))
    throw new Error(`kay's declarations were not built:\n${stderr.toString()}`)

  try {
    renameSync(building, dir)
  }
  catch (error) {
    rmSync(building, { recursive: true, force: true })

    // Another worker moving its build in first is the one failure that leaves the declarations in place.
    if (!existsSync(dir))
      throw error
  }
}

// Builds unused for a day, of sources since changed, go.
function pruneOthers(keep: string): void {
  for (const entry of existsSync(CACHE) ? readdirSync(CACHE) : []) {
    const path = join(CACHE, entry)

    if (entry !== keep && Date.now() - statSync(path).mtimeMs > KEPT_MS)
      rmSync(path, { recursive: true, force: true })
  }
}

function declarationPaths(): Record<string, string[]> {
  const key = sourceKey()
  const dir = join(CACHE, key)

  if (existsSync(dir))
    utimesSync(dir, new Date(), new Date())
  else
    buildDeclarations(dir)

  pruneOthers(key)

  const { exports } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { exports: Record<string, string | { types?: string }> }
  const paths: Record<string, string[]> = {}

  for (const [subpath, target] of Object.entries(exports)) {
    const types = typeof target === 'object' ? target.types : undefined

    if (types?.startsWith('./types/'))
      paths[subpath === '.' ? 'kay' : `kay/${subpath.slice(2)}`] = [join(dir, types.slice('./types/'.length))]
  }

  return paths
}

// `paths` for a test project's tsconfig, typing `kay` from its declarations as an app installing the package does: through the checkout's link a check type-checks kay's own sources too, about 590 files, four times the CPU and twice the memory of the project's own check.
export function kayTypes(): Record<string, string[]> {
  built ??= declarationPaths()

  return built
}
