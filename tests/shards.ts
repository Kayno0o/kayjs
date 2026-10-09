import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { limiter } from '../src/server/limit'

// Runs `bun test` as a few shards at once, every shard but the first in a copy of this checkout: the test files build into the same fixtures, which one checkout cannot run side by side (#146).
// `bun tests/shards.ts [count]`, or `bun tests/shards.ts --update-timings` to measure each file again into tests/timings.json, which balances the shards by time.
const ROOT = join(import.meta.dir, '..')
const TIMINGS = 'tests/timings.json'
// One shard's output at a time, whole, as two shards may end together.
const print = limiter(1)

async function run(command: string[], cwd: string): Promise<{ output: string, code: number }> {
  // One pipe for both streams, so a failure stays next to the test that printed it.
  const child = Bun.spawn(['sh', '-c', 'exec "$@" 2>&1', 'sh', ...command], { cwd, stdout: 'pipe', stdin: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return { output, code }
}

async function gitFiles(...flags: string[]): Promise<string[]> {
  const listed = await run(['git', 'ls-files', '-z', ...flags], ROOT)

  if (listed.code !== 0)
    throw new Error(`git ls-files in ${ROOT} failed:\n${listed.output}`)

  return listed.output.split('\0').filter(Boolean)
}

// The working tree as it stands, uncommitted changes included, with its own install.
async function copyCheckout(dir: string) {
  const [files, deleted] = await Promise.all([gitFiles('--cached', '--others', '--exclude-standard'), gitFiles('--deleted')])
  const gone = new Set(deleted)

  // copyFile keeps the mode, so an executable stays one.
  await Promise.all(files.filter(file => !gone.has(file)).map(async (file) => {
    await mkdir(dirname(join(dir, file)), { recursive: true })
    await copyFile(join(ROOT, file), join(dir, file))
  }))

  const install = await run([process.execPath, 'install', '--frozen-lockfile', '--silent'], dir)

  if (install.code !== 0)
    throw new Error(`bun install in ${dir} failed:\n${install.output}`)
}

const updating = process.argv[2] === '--update-timings'
const count = updating ? 1 : Number(process.argv[2] ?? 3)

if (!Number.isInteger(count) || count < 1)
  throw new Error(`tests/shards.ts takes a number of shards, not ${process.argv[2]}`)

const copies = await mkdtemp(join(tmpdir(), 'kay-shards-'))
let failed = false

try {
  // Measuring runs the whole suite once in a copy, whose run lock is its own: a wait for a run in this checkout would count against the first file.
  const dirs = updating ? [join(copies, 'timings')] : [ROOT, ...Array.from({ length: count - 1 }, (_, index) => join(copies, `shard-${index + 2}`))]

  await Promise.all(dirs.filter(dir => dir !== ROOT).map(copyCheckout))
  await Promise.all(dirs.map(async (dir, index) => {
    const started = performance.now()
    const { output, code } = await run([process.execPath, 'test', `--timings=${join(ROOT, TIMINGS)}`, updating ? '--update-timings' : `--shard=${index + 1}/${count}`], dir)

    failed ||= code !== 0
    // Awaited, as a write to a pipe left pending when the process ends loses its tail.
    await print(async () => Bun.write(Bun.stdout, `\n== shard ${index + 1}/${count}: exit ${code} in ${((performance.now() - started) / 1000).toFixed(1)}s\n${output}`))
  }))
}
finally {
  await rm(copies, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
