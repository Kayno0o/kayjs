import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { testWorker } from '../src/build/assets'

const LOCK = join(import.meta.dir, '../docs/.kay/build.lock')
const HOLDER = join(LOCK, 'pid')

// A lock whose holder is no longer running belongs to a test that died; one still running keeps it however long its build takes.
async function heldByTheDead(): Promise<boolean> {
  let pid: number

  try {
    pid = Number(await readFile(HOLDER, 'utf8'))
  }
  catch {
    // Taken an instant ago, its pid not written yet, unless its holder died in between.
    try {
      return Date.now() - (await stat(LOCK)).mtimeMs > 10_000
    }
    catch {
      return false
    }
  }

  try {
    process.kill(pid, 0)

    return false
  }
  catch {
    return true
  }
}

// Tests of one parallel run each build the docs into `docs/.kay` and read or serve it: one at a time, as a build wipes the last one. Returns what releases the turn.
export async function takeDocsBuild(keepsBuild = false): Promise<() => Promise<void>> {
  await mkdir(join(LOCK, '..'), { recursive: true })

  for (;;) {
    try {
      await mkdir(LOCK)
      await writeFile(HOLDER, String(process.pid))

      // A build of its own replaces what the last one wrote, so the one a reader kept is no longer there.
      if (!keepsBuild)
        await rm(stampFile(), { force: true })

      return async () => rm(LOCK, { recursive: true, force: true })
    }
    catch {
      if (await heldByTheDead())
        await rm(LOCK, { recursive: true, force: true })

      await Bun.sleep(200)
    }
  }
}

const CLI = join(import.meta.dir, '../src/cli.ts')
const ROOT = join(import.meta.dir, '..')
const SOURCES = '{docs,src,packages}/**/*'
const IGNORED = /(?:^|\/)(?:node_modules|\.kay|dist|\.git)\//

function stampFile(): string {
  return join(LOCK, '..', `built${testWorker()}.json`)
}

// What the build reads, by size and modification time, and the run asking: a build of these sources from this run is still the one on disk.
async function stampOfSources(): Promise<string> {
  const parts: string[] = [String(process.env.BUN_TEST_WORKER_ID === undefined ? process.pid : process.ppid)]

  for await (const file of new Bun.Glob(SOURCES).scan({ cwd: ROOT, onlyFiles: true })) {
    if (IGNORED.test(file))
      continue

    const info = await stat(join(ROOT, file))

    parts.push(`${file}:${info.size}:${info.mtimeMs}`)
  }

  return String(Bun.hash(parts.sort().join('\n')))
}

async function readStamp(): Promise<string> {
  try {
    return await readFile(stampFile(), 'utf8')
  }
  catch {
    return ''
  }
}

// `takeDocsBuild` for a test reading the build `kay build docs --no-check` writes: it builds unless this run already built the same sources, which a file holding the turn since then has not touched.
export async function takeDocsBuilt(): Promise<() => Promise<void>> {
  const release = await takeDocsBuild(true)

  try {
    const stamp = await stampOfSources()
    const kept = await readStamp()

    if (kept === stamp)
      return release

    const child = Bun.spawn([process.execPath, CLI, 'build', 'docs', '--no-check'], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (code !== 0)
      throw new Error(errors)

    await writeFile(stampFile(), stamp)

    return release
  }
  catch (error) {
    await release()

    throw error
  }
}
