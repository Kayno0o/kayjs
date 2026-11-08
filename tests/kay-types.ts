import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'

const ROOT = join(import.meta.dir, '..')
// Inside the checkout, so the declarations resolve kay's dependencies from its node_modules, and where `bun pm pack` never looks.
const CACHE = join(ROOT, 'node_modules/.cache/kay-types')
const KEPT_MS = 24 * 60 * 60 * 1000
const SOURCE = /\.tsx?$/

let built: Promise<Record<string, string[]>> | undefined

// What decides the declarations: the sources, the configs they build with and Bun, whose tsgo emits them.
function sourceKey(): string {
  const hasher = new Bun.CryptoHasher('sha1')

  hasher.update(Bun.version)

  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.build.json'])
    hasher.update(`\0${file}\0`).update(readFileSync(join(ROOT, file)))

  const sources = readdirSync(join(ROOT, 'src'), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && SOURCE.test(entry.name)).map(entry => join(entry.parentPath, entry.name)).sort()

  for (const file of sources)
    hasher.update(`\0${relative(ROOT, file)}\0`).update(readFileSync(file))

  return hasher.digest('hex').slice(0, 16)
}

// Builds into a directory of this process's own, then moves it in place, so a reader never sees half a build; a worker that lost the race drops its copy.
async function buildDeclarations(dir: string): Promise<void> {
  const building = `${dir}.${process.pid}`

  await mkdir(CACHE, { recursive: true })

  // Type errors in the sources still emit their declarations, so only a missing entry fails.
  const child = Bun.spawn([process.execPath, join(ROOT, 'src/tsgo.ts'), '-p', join(ROOT, 'tsconfig.build.json'), '--outDir', building], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe', env: { ...process.env, NODE_ENV: undefined } })
  const [errors] = await Promise.all([new Response(child.stderr).text(), child.exited])

  if (!existsSync(join(building, 'runtime/index.d.ts')))
    throw new Error(`kay's declarations were not built:\n${errors}`)

  try {
    await rename(building, dir)
  }
  catch {
    await rm(building, { recursive: true, force: true })
  }
}

// Builds a day old, of sources since changed, go.
function pruneOthers(keep: string): void {
  for (const entry of existsSync(CACHE) ? readdirSync(CACHE) : []) {
    const path = join(CACHE, entry)

    if (entry !== keep && Date.now() - statSync(path).mtimeMs > KEPT_MS)
      rmSync(path, { recursive: true, force: true })
  }
}

async function declarationPaths(): Promise<Record<string, string[]>> {
  const key = sourceKey()
  const dir = join(CACHE, key)

  if (!existsSync(dir))
    await buildDeclarations(dir)

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
export async function kayTypes(): Promise<Record<string, string[]>> {
  built ??= declarationPaths()

  return built
}
