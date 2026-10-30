import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Glob } from 'bun'

// `bun scripts/test-memory.ts [--update] [--all] <test files>`: runs each test file alone under `bun test` and keeps the peak memory of the process and every child it starts (a browser, a server, a build) in `tests/memory.json`, as `tests/timings.json` keeps their times.
// A worker of `bun test --parallel` keeps what a file loaded once the file loaded a native addon (oven-sh/bun#46561), so the files a landing runs together add up: a file past HEAVY_MB is the one to bring down first, and one that grew past what is kept shows as a regression.
// Memory is the proportional set size of each process, so a page two processes share counts once.
const ROOT = join(import.meta.dir, '..')
const KEPT = join(ROOT, 'tests', 'memory.json')
const SAMPLE_MS = 50

// A file over this in a run of its own is brought down before it joins others.
export const HEAVY_MB = 500
// A measurement past the kept one by this share and this many MB counts as a regression.
const GROWTH = 1.25
const GROWTH_MB = 50
const PID = /^\d+$/
const TEST_FILES = new Glob('tests/**/*.test.{ts,tsx,js,jsx}')

interface Kept { version: number, files: Record<string, number> }

// A process by its parent, read from /proc: the command is in parentheses and may hold spaces, so the fields are counted from the last one.
function parents(): Map<number, number> {
  const parentOf = new Map<number, number>()

  for (const name of readdirSync('/proc')) {
    if (!PID.test(name))
      continue

    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')

      parentOf.set(Number(name), Number.parseInt(stat.slice(stat.lastIndexOf(')') + 4), 10))
    }
    catch {
      // Gone since the listing.
    }
  }

  return parentOf
}

export function descendants(root: number, parentOf: ReadonlyMap<number, number>): number[] {
  const found = [root]

  for (const pid of found) {
    for (const [child, parent] of parentOf) {
      if (parent === pid && !found.includes(child))
        found.push(child)
    }
  }

  return found
}

const PSS = /^Pss:\s+(\d+) kB$/m

function pssKb(pid: number): number {
  try {
    return Number(PSS.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0)
  }
  catch {
    return 0
  }
}

// Runs `argv` and answers its exit code and the most memory it and its children held together at once, in MB.
export async function peakOf(argv: string[], cwd: string): Promise<{ exitCode: number, peakMb: number }> {
  const child = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  let peak = 0
  const state = { done: false }
  const sampling = (async () => {
    while (!state.done) {
      peak = Math.max(peak, descendants(child.pid, parents()).reduce((sum, pid) => sum + pssKb(pid), 0))
      await Bun.sleep(SAMPLE_MS)
    }
  })()
  const exitCode = await child.exited

  state.done = true
  await sampling

  return { exitCode, peakMb: Math.round(peak / 1024) }
}

// The files that grew past what is kept, with both figures.
export function regressions(kept: Record<string, number>, measured: Record<string, number>): { file: string, was: number, now: number }[] {
  return Object.entries(measured).flatMap(([file, now]) => {
    const was = kept[file]

    return was !== undefined && now > was * GROWTH && now - was > GROWTH_MB ? [{ file, was, now }] : []
  })
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const update = args.includes('--update')
  const names = args.filter(arg => !arg.startsWith('--'))
  const kept = (await Bun.file(KEPT).json() as Kept).files
  const files = args.includes('--all') ? await Array.fromAsync(TEST_FILES.scan({ cwd: ROOT })) : names
  const measured: Record<string, number> = {}

  for (const file of files) {
    const { exitCode, peakMb } = await peakOf([process.execPath, 'test', file], ROOT)

    measured[file] = peakMb
    console.log(`${file}: ${peakMb} MB${kept[file] === undefined ? '' : ` (kept ${kept[file]} MB)`}${peakMb > HEAVY_MB ? ', heavy' : ''}${exitCode === 0 ? '' : `, exit ${exitCode}`}`)
  }

  for (const { file, was, now } of regressions(kept, measured))
    console.log(`grew: ${file} from ${was} MB to ${now} MB`)

  if (update) {
    const merged = Object.entries({ ...kept, ...measured }).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

    await Bun.write(KEPT, `${JSON.stringify({ version: 1, files: Object.fromEntries(merged) }, null, 2)}\n`)
  }
}
