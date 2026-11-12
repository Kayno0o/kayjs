import process from 'node:process'
import { $ } from 'bun'

// `bun scripts/release-apps.ts`: waits for the Apps workflow to pass on HEAD, dispatching it when no run of it covers HEAD yet, so a release leaves only code the apps on kay have run against; KAY_SKIP_APPS_CI=1 skips it.
const WORKFLOW = 'apps.yml'

// Until every app is upgraded to the last 1.x minor (the #2595 box "every app on kay ... bumped to the last 1.x minor"), a red run is only printed; that box sets this to true so a red run blocks the release.
export const BLOCKING = false
const POLL_MS = 20_000
const LIMIT_MS = 45 * 60_000

export const SECRET_UNSET = 'KAY_APPS_TOKEN is not set'

// The exit code for a finished run: 0 for a pass, and for a red run only once the apps are meant to block a release.
export const exitCode = (status: string, blocking: boolean) => status === 'success' || !blocking ? 0 : 1

export const NO_FT = 'ft is not on PATH'

// Under --json ft reports a failure as {error, hint?} on stderr; anything else is its own words.
function refusal(stderr: string): string {
  const text = stderr.trim()

  try {
    const { error, hint } = JSON.parse(text) as { error?: string, hint?: string }

    if (typeof error === 'string')
      return hint === undefined ? error : `${error} (${hint})`
  }
  catch {}

  return text
}

// Dispatches the workflow on `sha` through `ft dispatch`, answering the id of the run it started or why it could not.
export async function dispatchRun(workflow: string, sha: string, options: { path?: string } = {}): Promise<{ id: number } | { error: string }> {
  const env = options.path === undefined ? process.env : { ...process.env, PATH: options.path }

  if (Bun.which('ft', { PATH: env.PATH ?? '' }) === null)
    return { error: NO_FT }

  const started = await $`ft dispatch ${workflow} --ref ${sha} --json`.env(env).quiet().nothrow()

  if (started.exitCode !== 0)
    return { error: refusal(started.stderr.toString()) || `exit ${started.exitCode}` }

  return { id: (JSON.parse(started.stdout.toString()) as { id: number }).id }
}

interface Run {
  id: number
  status: string
  event: string
  sha: string
  url: string
}

if (import.meta.main)
  await main()

async function main() {
  if (process.env.KAY_SKIP_APPS_CI === '1') {
    console.log('KAY_SKIP_APPS_CI is set, the apps on kay are not run')
    process.exit(0)
  }

  const sha = (await $`git rev-parse HEAD`.text()).trim()

  // A release is of the pushed main, the only commit of it Forgejo can run.
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
  let run = (await runs()).find(candidate => candidate.status !== 'failure' && candidate.status !== 'cancelled')
  let id = run?.id

  // A run still going or passed is waited on; a failed one is run again, as the apps may have been fixed since.
  if (id === undefined) {
    console.log(`dispatching ${WORKFLOW} on ${sha.slice(0, 7)}`)
    const dispatched = await dispatchRun(WORKFLOW, sha)

    if ('error' in dispatched) {
      console.error(`dispatching ${WORKFLOW} failed: ${dispatched.error}`)
      process.exit(exitCode('failure', BLOCKING))
    }

    id = dispatched.id
  }

  const deadline = Date.now() + LIMIT_MS

  while (Date.now() < deadline) {
    run = (await runs()).find(candidate => candidate.id === id)

    if (run !== undefined && finished(run))
      break

    await Bun.sleep(POLL_MS)
  }

  if (run === undefined || !finished(run)) {
    console.error(`the ${WORKFLOW} run on ${sha.slice(0, 7)} did not finish in time`)
    process.exit(exitCode('failure', BLOCKING))
  }

  if (run.status !== 'success') {
    console.error(`the apps on kay fail against ${sha.slice(0, 7)}: ${run.url}`)

    const logs = await $`ft logs ${run.id}`.nothrow().text()

    console.error(logs)

    if (logs.includes(SECRET_UNSET))
      console.error('the Actions secret KAY_APPS_TOKEN is not set, so no app was run')

    if (!BLOCKING)
      console.error('the release goes on: the apps are not upgraded to the last 1.x minor yet (#2595)')

    process.exit(exitCode(run.status, BLOCKING))
  }

  console.log(`the apps on kay pass against ${sha.slice(0, 7)}: ${run.url}`)
}
