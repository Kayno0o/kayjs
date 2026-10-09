import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// Runs `bun test` as a few shards at once, every shard but the first in a copy of this checkout: the test files build into the same fixtures, which one checkout cannot run side by side (#146).
// `bun tests/shards.ts [count]`, or `bun tests/shards.ts --update-timings` to measure each file again into tests/timings.json, which balances the shards by time.
const ROOT = join(import.meta.dir, '..')
const TIMINGS = 'tests/timings.json'

async function run(command: string[], cwd: string): Promise<{ output: string, code: number }> {
  // One pipe for both streams, so a failure stays next to the test that printed it.
  const child = Bun.spawn(['sh', '-c', 'exec "$@" 2>&1', 'sh', ...command], { cwd, stdout: 'pipe', stdin: 'ignore' })
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

  return { output, code }
}

// The working tree as it stands, uncommitted changes included, with its own install.
async function copyCheckout(dir: string) {
  const listed = await run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], ROOT)

  if (listed.code !== 0)
    throw new Error(`git ls-files in ${ROOT} failed:\n${listed.output}`)

  await Promise.all(listed.output.split('\0').filter(Boolean).map(async file => Bun.write(join(dir, file), Bun.file(join(ROOT, file)))))

  const install = await run([process.execPath, 'install', '--frozen-lockfile', '--silent'], dir)

  if (install.code !== 0)
    throw new Error(`bun install in ${dir} failed:\n${install.output}`)
}

if (process.argv[2] === '--update-timings') {
  const { output, code } = await run([process.execPath, 'test', `--timings=${TIMINGS}`, '--update-timings'], ROOT)

  process.stdout.write(output)
  process.exit(code)
}

const count = Number(process.argv[2] ?? 3)
const copies = await mkdtemp(join(tmpdir(), 'kay-shards-'))
let failed = false

try {
  const dirs = [ROOT, ...Array.from({ length: count - 1 }, (_, index) => join(copies, `shard-${index + 2}`))]

  await Promise.all(dirs.slice(1).map(copyCheckout))
  await Promise.all(dirs.map(async (dir, index) => {
    const started = performance.now()
    const { output, code } = await run([process.execPath, 'test', `--shard=${index + 1}/${count}`, `--timings=${join(ROOT, TIMINGS)}`], dir)

    failed ||= code !== 0
    process.stdout.write(`\n== shard ${index + 1}/${count}: exit ${code} in ${((performance.now() - started) / 1000).toFixed(1)}s\n${output}`)
  }))
}
finally {
  await rm(copies, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
