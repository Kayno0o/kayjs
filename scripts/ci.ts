import process from 'node:process'
import { $ } from 'bun'
import { failedTests } from './test-failures'

// `just ci [sha]`: waits for the Tests run covering a commit on main, by default origin's tip, and on a failure prints what each failed job's log says. A push's run tests every commit since the last one passed, so a commit whose own run was cancelled or left its tests to a newer push's, or which started none, is covered by the first later run that tests.
interface Run { id: number, commit_sha: string, event: string, html_url: string, status: string, workflow_id: string }
interface Job { id: number, name: string, status: string }

const WORKFLOW = 'test.yml'
const POLL = 15_000
const GIVE_UP = 30 * 60_000
// How long the wait goes on with no run covering the commit, since it started or last saw one: a push runs nothing when it only touches .md files, and a cancelled run's successor may take a poll to appear.
const NO_RUN = 3 * 60_000
const DONE = new Set(['success', 'failure', 'skipped'])
const QUEUED = new Set(['waiting', 'blocked'])
const TEST_JOB = 'test'
const VERSION = /^v\d/
// How long a run may wait while the runner runs nothing before the wait is given up: a hung run ends at its timeout, so this is a runner that is down.
const STALLED = 3 * 60_000
const STAMP = /^\S+Z /
const FAILED_STEP = /❌\s+Failure - Main /
// Lines of a failed step shown above its failure, which name its error and, for tests, list the failed ones.
const STEP_TAIL = 30
const PASS = '(pass) '

function fail(message: string, code: number): never {
  console.error(`ci: ${message}`)
  process.exit(code)
}

async function api<T>(path: string): Promise<T> {
  return JSON.parse(await $`tea api ${`repos/{owner}/{repo}/${path}`}`.quiet().text()) as T
}

// Commits whose run is over without testing, which no later poll needs to ask about again.
const passedOver = new Set<string>()

// The run that answers for this commit: the newest Tests run on it, unless cancelled or finished with its tests left to a newer push's run.
async function runOf(commit: string): Promise<Run | undefined> {
  if (passedOver.has(commit))
    return undefined

  const { workflow_runs: runs } = await api<{ workflow_runs: Run[] | null }>(`actions/runs?head_sha=${commit}`)
  const own = (runs ?? []).filter(run => run.workflow_id === WORKFLOW && run.event === 'push').sort((a, b) => b.id - a.id)[0]

  if (own === undefined || (!DONE.has(own.status) && own.status !== 'cancelled'))
    return own

  if (own.status !== 'cancelled' && !(await api<Job[]>(`actions/runs/${own.id}/jobs`)).some(job => job.name === TEST_JOB && job.status === 'skipped'))
    return own

  // A release's version commit skips these tests for its tag's publish workflow, on the same tree.
  if (own.status !== 'cancelled' && VERSION.test(await $`git log -1 --format=%s ${commit}`.text()))
    return { ...own, status: 'skipped' }

  passedOver.add(commit)

  return undefined
}

async function runnerBusy(): Promise<boolean> {
  return ((await api<{ workflow_runs: Run[] | null }>('actions/runs?status=running')).workflow_runs ?? []).length > 0
}

// Each failed test's own output, then the end of each failed step, the passing tests left out.
function excerpt(log: string): string {
  const lines = log.split('\n').map(line => line.replace(STAMP, ''))
  const parts = failedTests(lines)

  for (const [index, line] of lines.entries()) {
    if (FAILED_STEP.test(line))
      parts.push(lines.slice(Math.max(0, index - STEP_TAIL), index + 1).filter(text => text.trim() !== '' && !text.startsWith(PASS) && !text.startsWith('::')).join('\n'))
  }

  return parts.join('\n\n')
}

const sha = (await $`git rev-parse --verify -q ${`${process.argv[2] ?? 'origin/main'}^{commit}`}`.nothrow().quiet().text()).trim()

if (sha === '')
  fail(`no commit ${process.argv[2]}`, 2)

const short = sha.slice(0, 7)
const started = Date.now()
let seen = started
let moving = started
let followed: Run | undefined
let finished: Run | undefined

// The first run at or after the commit that was not cancelled, as each push's run tests every commit since the last one passed.
async function coveringRun(): Promise<Run | undefined> {
  await $`git fetch -q origin main`.quiet()

  if ((await $`git merge-base --is-ancestor ${sha} origin/main`.nothrow()).exitCode !== 0)
    fail(`${short} is not on origin's main: land it first`, 2)

  for (const commit of [sha, ...(await $`git rev-list --reverse --first-parent ${sha}..origin/main`.text()).split('\n').filter(Boolean)]) {
    const run = await runOf(commit)

    if (run !== undefined)
      return run
  }

  return undefined
}

while (finished === undefined) {
  if (Date.now() - started > GIVE_UP)
    fail(`CI has not finished on ${short} in ${GIVE_UP / 60_000} minutes${followed === undefined ? '' : `: ${followed.html_url}`}`, 2)

  let run: Run | undefined

  // Forgejo or origin missing one poll leaves the wait to the next.
  try {
    run = await coveringRun()
  }
  catch (error) {
    console.warn(`ci: ${error instanceof Error ? error.message : String(error)}, polling again`)
    await Bun.sleep(POLL)

    continue
  }

  if (run !== undefined)
    seen = Date.now()

  if (run !== undefined && run.id !== followed?.id) {
    followed = run
    console.log(`following run ${run.id} on ${run.commit_sha.slice(0, 7)}${run.commit_sha === sha ? '' : `, which covers ${short}`}: ${run.html_url}`)
  }

  if (run !== undefined && DONE.has(run.status)) {
    finished = run

    continue
  }

  if (run === undefined || !QUEUED.has(run.status) || await runnerBusy())
    moving = Date.now()
  else if (Date.now() - moving > STALLED)
    fail(`run ${run.id} has waited ${Math.round((Date.now() - moving) / 60_000)} minutes while the runner runs nothing: is it up? ${run.html_url}`, 2)

  if (run === undefined && Date.now() - seen > NO_RUN)
    fail(`no Tests run covers ${short} yet: its own was cancelled by a later push or never started, as a push touching only .md files starts none, so the next landing's run will`, 2)

  await Bun.sleep(POLL)
}

if (finished.status !== 'failure') {
  console.log(`CI ${finished.status === 'success' ? 'passed' : 'skipped its tests, a release\'s publish workflow testing it'} on ${short}: ${finished.html_url}`)
  process.exit(0)
}

for (const job of await api<Job[]>(`actions/runs/${finished.id}/jobs`)) {
  if (job.status !== 'failure')
    continue

  console.error(`\njob ${job.name} failed:\n${excerpt(await $`tea api ${`repos/{owner}/{repo}/actions/jobs/${job.id}/logs`}`.quiet().text())}`)
}

fail(`run ${finished.id} failed${finished.commit_sha === sha ? '' : `, testing every commit from ${short} to ${finished.commit_sha.slice(0, 7)}`}: ${finished.html_url}`, 1)
