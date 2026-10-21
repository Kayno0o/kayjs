import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { $, Glob } from 'bun'

// `bun scripts/timings.ts`: writes `.kay/timings.json`, the file `bun run test` schedules by, so no session measures the suite by hand.
// It starts from the committed `tests/timings.json`, takes the newest green push run's measurement from its log when Forgejo is reachable through `tea`, and gives a test file no measurement yet an estimate that puts it among the first to start.
// Bun starts files it has no timing for in the middle of the run, which let a slow new file stretch it.
const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, '.kay', 'timings.json')
const SEEN = join(ROOT, '.kay', 'timings-run')
const COMMITTED = join(ROOT, 'tests', 'timings.json')
const WORKFLOW = 'test.yml'
const TEST_JOB = 'test'

// The CI step that prints the whole measurement on one line, which this reads back.
export const MARKER = 'KAY_TIMINGS '
const STAMP = /^\S+Z /

// A file with no measurement starts among the slowest ones until a run measures it.
export const UNMEASURED_MS = 20_000
// Runs tried for a measurement, and the seconds a tea call may take before a stalled network stops holding the test run.
const TRIED = 5
const FETCH_SECONDS = 30
const TEST_FILES = new Glob('tests/**/*.test.{ts,tsx,js,jsx}')

interface Timings { version: number, files: Record<string, number> }
interface Run { id: number, workflow_id: string, event: string }
interface Job { id: number, name: string }

async function api<T>(path: string): Promise<T> {
  return JSON.parse(await $`timeout ${FETCH_SECONDS} tea api ${`repos/{owner}/{repo}/${path}`}`.quiet().text()) as T
}

// The measurement a run's log carries, if its test step printed one.
export function measurementOf(log: string): Record<string, number> | undefined {
  for (const raw of log.split('\n').reverse()) {
    const line = raw.replace(STAMP, '')

    if (line.startsWith(MARKER))
      return (JSON.parse(line.slice(MARKER.length)) as Timings).files
  }

  return undefined
}

// Files without a measurement get the estimate, and files gone from disk leave the map.
export function merge(known: Record<string, number>, onDisk: string[]): Record<string, number> {
  const files: Record<string, number> = {}

  for (const file of onDisk)
    files[file] = known[file] ?? UNMEASURED_MS

  return files
}

// The newest green runs' logs are tried in turn, as the runs from before CI printed the measurement have none; the answer, empty or not, is kept under the newest run's id so a local run downloads nothing again until a newer run is green.
async function latestMeasurement(): Promise<Record<string, number> | undefined> {
  if (Bun.which('tea') === null)
    return undefined

  const { workflow_runs: runs } = await api<{ workflow_runs: Run[] | null }>('actions/runs?status=success')
  const candidates = (runs ?? []).filter(run => run.workflow_id === WORKFLOW && run.event === 'push').sort((a, b) => b.id - a.id).slice(0, TRIED)
  const newest = candidates[0]

  if (newest === undefined)
    return undefined

  const seen = await Bun.file(SEEN).exists() ? await Bun.file(SEEN).text() : ''

  if (seen.startsWith(`${newest.id} `))
    return JSON.parse(seen.slice(String(newest.id).length + 1)) as Record<string, number>

  let files: Record<string, number> = {}

  for (const run of candidates) {
    const job = (await api<Job[]>(`actions/runs/${run.id}/jobs`)).find(candidate => candidate.name === TEST_JOB)
    const found = job === undefined ? undefined : measurementOf(await $`timeout ${FETCH_SECONDS} tea api ${`repos/{owner}/{repo}/actions/jobs/${job.id}/logs`}`.quiet().text())

    if (found !== undefined) {
      files = found

      break
    }
  }

  await Bun.write(SEEN, `${newest.id} ${JSON.stringify(files)}`)

  return files
}

if (import.meta.main) {
  const committed = (await Bun.file(COMMITTED).json() as Timings).files
  let measured: Record<string, number> | undefined

  try {
    measured = await latestMeasurement()
  }
  catch (error) {
    console.warn(`timings: no CI measurement (${error instanceof Error ? error.message.trim() : String(error)}), scheduling by the committed one`)
  }

  const onDisk = await Array.fromAsync(TEST_FILES.scan({ cwd: ROOT }))
  const files = merge({ ...committed, ...measured }, onDisk)
  const sorted = Object.entries(files).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  await mkdir(join(ROOT, '.kay'), { recursive: true })
  await Bun.write(OUT, `${JSON.stringify({ version: 1, files: Object.fromEntries(sorted) }, null, 2)}\n`)
  process.exit(0)
}
