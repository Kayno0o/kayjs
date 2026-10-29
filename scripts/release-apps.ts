import process from 'node:process'
import { $ } from 'bun'

// `bun scripts/release-apps.ts`: waits for the Apps workflow to pass on HEAD, dispatching it when no run of it covers HEAD yet, so a release leaves only code the apps on kay have run against; KAY_SKIP_APPS_CI=1 skips it.
const WORKFLOW = 'apps.yml'
const POLL_MS = 20_000
const LIMIT_MS = 45 * 60_000

interface Run {
  id: number
  status: string
  event: string
  sha: string
  url: string
}

if (process.env.KAY_SKIP_APPS_CI === '1') {
  console.log('KAY_SKIP_APPS_CI is set, the apps on kay are not run')
  process.exit(0)
}

const sha = (await $`git rev-parse HEAD`.text()).trim()

// The dispatch runs main's tip, so a HEAD that is not it would never get a run of its own.
await $`git fetch -q origin main`

if ((await $`git rev-parse origin/main`.text()).trim() !== sha) {
  console.error('HEAD is not origin/main: the Apps workflow runs the pushed main')
  process.exit(1)
}

async function runs(): Promise<Run[]> {
  return JSON.parse(await $`ft runs --workflow ${WORKFLOW} --sha ${sha} --limit 10 --json`.text()) as Run[]
}

const TERMINAL = new Set(['success', 'failure', 'cancelled', 'skipped'])
const finished = (candidate: Run) => TERMINAL.has(candidate.status)
// Runs from before the dispatch are ignored once it is made, so an earlier failure is not taken for its result.
let ignored = new Set<number>()
let run = (await runs()).find(candidate => candidate.status !== 'failure' && candidate.status !== 'cancelled')

// A run still going or passed is waited on; a failed one is run again, as the apps may have been fixed since.
if (run === undefined) {
  ignored = new Set((await runs()).map(candidate => candidate.id))
  console.log(`dispatching ${WORKFLOW} on ${sha.slice(0, 7)}`)
  await $`tea api -X POST ${`repos/{owner}/{repo}/actions/workflows/${WORKFLOW}/dispatches`} -d ${JSON.stringify({ ref: 'main' })}`.quiet()
}

const deadline = Date.now() + LIMIT_MS

while (Date.now() < deadline) {
  run = (await runs()).find(candidate => !ignored.has(candidate.id))

  if (run !== undefined && finished(run))
    break

  await Bun.sleep(POLL_MS)
}

if (run === undefined || !finished(run)) {
  console.error(`the ${WORKFLOW} run on ${sha.slice(0, 7)} did not finish in time`)
  process.exit(2)
}

if (run.status !== 'success') {
  console.error(`the apps on kay fail against ${sha.slice(0, 7)}: ${run.url}`)
  await $`ft logs ${run.id}`.nothrow()
  process.exit(1)
}

console.log(`the apps on kay pass against ${sha.slice(0, 7)}: ${run.url}`)
