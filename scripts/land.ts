import { appendFile } from 'node:fs/promises'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { $, Glob } from 'bun'
import { addedMarkers } from './merge-markers'
import { failedTests } from './test-failures'

// `just land`: this branch rebased on origin's main, linted, checked and run through the tests its changes reach, then pushed as main, and the main checkout moved to it. The full suite is CI's, on every push, which `just ci` follows.
// Landings verify side by side and queue only for the push: the one that finds origin's main where its rebase left it pushes at once under the landing lock, one that finds it moved rebases and verifies again under the lock.
// It prints one line per step, their output going to a log in the worktree's git folder, and a failure ends on the step's last lines, exiting with one of EXIT's codes.
const EXIT = { unlandable: 2, conflict: 3, step: 4, refused: 5 }
const LOG = join((await $`git rev-parse --absolute-git-dir`.text()).trim(), 'land.log')
// Lines of a failing step's output shown, the rest staying in the log: its last ones, or after its failed tests only bun test's summary.
const TAIL = 30
const SUMMARY = 8
const FIXTURE = /^tests\/fixtures\/([^/]+)\//
const PACKAGE = /^packages\/([^/]+)\//
// Read by every test file or by kay itself rather than imported, so `bun test --changed` cannot follow them.
const WHOLE_SUITE = /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|eslint\.(?:config|base|slices)\.ts|src\/(?:.*\/)?[^/]+(?<!\.ts))$/
// Tests reading these folders as files, which an import graph does not show.
const READERS: [RegExp, string[]][] = [
  [/^(?:llms\/|llms\.txt$)/, ['tests/llms.test.ts', 'tests/docs.test.ts']],
  [/^docs\//, ['tests/docs.test.ts', 'tests/examples.test.ts']],
  [/^examples\//, ['tests/examples.test.ts', 'tests/new.test.ts', 'tests/docs.test.ts']],
  [/^packages\//, ['tests/llms.test.ts', 'tests/packages.test.ts', 'tests/docs.test.ts', 'tests/examples.test.ts', 'tests/library.test.ts', 'tests/new.test.ts']],
  [/^tests\/fixtures\//, ['tests/format.test.ts']],
  // Greps every tracked file for the private forge domain.
  [/^/, ['tests/public-repo.test.ts']],
]
// Half the host's cores, as CI runs them, so a landing leaves the machine to the rest; fewer with KAY_LAND_WORKERS, for a session short of memory beside other test runs.
const WORKERS = `--parallel=${Number(process.env.KAY_LAND_WORKERS) || 6}`
// How long a step may run before it counts as hung and is killed with every process it started: the whole suite takes minutes, a test stuck on a killed browser or child took hours.
const STEP_LIMIT_MS = Number(process.env.KAY_LAND_STEP_LIMIT_MS) || 30 * 60_000
// How long the output of a step that ended may stay open, as a process it started outside its group can hold it.
const DRAIN_MS = 5000
// The step running, whose process group goes with a landing stopped by a signal.
let running: number | undefined

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    killGroup(running)
    process.exit(128 + os.constants.signals[signal])
  })
}

function killGroup(pid: number | undefined) {
  try {
    if (pid !== undefined)
      process.kill(-pid, 'SIGKILL')
  }
  catch {
    // Already gone.
  }
}

function fail(message: string, code: number): never {
  console.error(`land failed: ${message}`)
  process.exit(code)
}

// `flock` on the lock file running a shell that says it holds it and keeps it while its stdin stays open, so a landing killed at any point frees it.
async function holder(lock: string, wait: boolean) {
  const child = Bun.spawn(['flock', ...wait ? [] : ['-n'], lock, 'sh', '-c', 'echo held; cat >/dev/null'], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  let said = ''

  for await (const chunk of child.stdout) {
    said += Buffer.from(chunk).toString()

    if (said.includes('held'))
      break
  }

  return { held: said.includes('held'), release: async () => {
    await child.stdin.end()
    await child.exited
  } }
}

// The landing lock, taken once the checks passed: a landing already holding it is waited for.
async function takeLock() {
  const lock = join((await $`git rev-parse --git-common-dir`.text()).trim(), 'kay-land.lock')
  const free = await holder(lock, false)

  if (free.held)
    return free.release

  console.log('waiting for another landing to finish')

  return (await holder(lock, true)).release
}

// Runs one step in a process group of its own, its output going to the log as it comes, and fails the landing on its failed tests and last lines, or on where it stood once it ran past STEP_LIMIT_MS.
async function step(label: string, argv: string[], cwd = '.') {
  const started = performance.now()

  process.stdout.write(`${label}: `)
  await appendFile(LOG, `$ ${label}\n`)

  // Its stderr into its stdout, so one pipe keeps their lines in the order they were written, the shell's own included, which says why a command could not start.
  const child = Bun.spawn(['sh', '-c', 'exec 2>&1; exec "$@"', 'sh', ...argv], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit', detached: true })
  let output = ''
  let hung = false
  const limit = setTimeout(() => {
    hung = true
    killGroup(child.pid)
  }, STEP_LIMIT_MS)
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const drained = (async () => {
    try {
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        const text = decoder.decode(read.value, { stream: true })

        output += text
        await appendFile(LOG, text)
      }
    }
    catch {
      // Cancelled, or the log could not be written: the step's output stays in `output`.
    }
  })()

  running = child.pid

  const exitCode = await child.exited

  running = undefined
  clearTimeout(limit)
  await Promise.race([drained, Bun.sleep(DRAIN_MS)])
  // A process left holding the pipe would otherwise keep the landing alive once it is done.
  await reader.cancel()
  await appendFile(LOG, '\n')

  const seconds = Math.round((performance.now() - started) / 1000)

  if (exitCode === 0 && !hung) {
    console.log(`ok, ${seconds} s`)

    return
  }

  console.log(hung ? `killed after ${seconds} s` : `exit ${exitCode}, ${seconds} s`)
  const lines = output.trimEnd().split('\n')

  const failures = failedTests(lines)

  console.error([...failures, lines.slice(failures.length > 0 ? -SUMMARY : -TAIL).join('\n')].join('\n\n'))
  fail(hung ? `${label} ran past ${STEP_LIMIT_MS / 1000} s, so it was killed with what it started: its output up to then is in ${LOG}` : `${label} exited with ${exitCode}: its whole output is in ${LOG}`, EXIT.step)
}

if ((await $`git status --porcelain`.text()).trim() !== '')
  fail('the working tree has changes: commit them first', EXIT.unlandable)

await Bun.write(LOG, '')

// Rebases on origin's main and runs the checks and tests the changes reach, answering the commit of origin's main it stands on.
async function verify(): Promise<string> {
  await $`git fetch -q origin main`

  if ((await $`git rebase -q origin/main`.nothrow().quiet()).exitCode !== 0) {
    const conflicts = (await $`git diff --name-only --diff-filter=U`.text()).trim().split('\n').join(', ')

    await $`git rebase --abort`.nothrow().quiet()
    fail(`the branch conflicts with main in ${conflicts}: rebase it by hand, then land again`, EXIT.conflict)
  }

  // The commit the branch now stands on: origin/main is shared by every worktree, so another landing's fetch moves it while this one verifies.
  const base = (await $`git merge-base origin/main HEAD`.text()).trim()
  const changed = (await $`git diff --name-only ${base} HEAD`.text()).split('\n').filter(Boolean)

  if (changed.length === 0)
    fail('nothing to land: the branch is main', EXIT.unlandable)

  // A rebase resolved by hand can leave a conflict marker in a file no check reads.
  const markers = addedMarkers(await $`git diff --unified=0 --no-color ${base} HEAD`.text())

  if (markers.length > 0)
    fail(`the branch adds merge markers: ${markers.map(({ file, line, text }) => `${file}:${line} (${text})`).join(', ')}`, EXIT.unlandable)

  // Main may have moved the lockfile under this branch.
  await step('bun install', ['bun', 'install', '--silent', '--frozen-lockfile'])
  await step('lint', ['bun', 'run', 'lint'])
  await step('check', ['bun', 'run', 'check'])

  if (changed.some(path => path.startsWith('bench/') || path === 'bun.lock')) {
    await step('bench:check', ['bun', 'run', 'bench:check'])
    await step('bench hydration markers', ['bun', 'test', './bench', '-t', 'leave hydration markers'])
  }
  else if (changed.some(path => path.startsWith('src/'))) {
    await step('bench:check:kay', ['bun', 'run', 'bench:check:kay'])
  }

  if (changed.some(path => path.startsWith('.forgejo/')))
    await step('lint-actions', ['just', 'lint-actions'])

  if (changed.some(path => WHOLE_SUITE.test(path))) {
    await step('tests, the whole suite', ['bun', 'run', 'test', WORKERS])
  }
  else {
    await step('tests the changes reach', ['bun', 'run', 'test', `--changed=${base}`, WORKERS])

    const readers = new Set(READERS.flatMap(([folder, tests]) => changed.some(path => folder.test(path)) ? tests : []))
    const fixtures = [...new Set(changed.map(path => FIXTURE.exec(path)?.[1]).filter(name => name !== undefined))]
    // A fixture's name as a path segment or a quoted string, as in `fixtures/site`, `join(fixtures, 'site')` or `fixtureCopy('site')`.
    const names = fixtures.map(name => new RegExp(`[/'"\`]${name}[/'"\`]`))

    if (names.length > 0) {
      for await (const test of new Glob('tests/*.test.ts').scan()) {
        const text = await Bun.file(test).text()

        if (names.some(name => name.test(text)))
          readers.add(test)
      }
    }

    if (readers.size > 0)
      await step('tests reading the changed files', ['bun', 'run', 'test', ...readers, WORKERS])
  }

  for (const name of new Set(changed.map(path => PACKAGE.exec(path)?.[1]).filter(name => name !== undefined))) {
    await step(`packages/${name} check`, ['bun', 'run', 'check'], `packages/${name}`)
    await step(`packages/${name} tests`, ['bun', 'run', 'test'], `packages/${name}`)
  }

  return base
}

let verified = await verify()
const release = await takeLock()

await $`git fetch -q origin main`

if ((await $`git rev-parse origin/main`.text()).trim() !== verified) {
  console.log('main moved while verifying: rebasing and verifying again')
  verified = await verify()
}

// origin pushes to Forgejo, then mirrors to GitHub: main is Forgejo's, so only its refusal stops a landing.
const [forge, ...mirrors] = (await $`git remote get-url --push --all origin`.text()).split('\n').filter(Boolean)
const head = (await $`git rev-parse HEAD`.text()).trim()
const pushed = await $`git push -q ${forge} HEAD:main`.nothrow().quiet()

if (pushed.exitCode !== 0) {
  await $`git fetch -q origin main`

  if ((await $`git rev-parse origin/main`.text()).trim() !== head)
    fail(`${forge} refused the push: ${pushed.stderr.toString().trim() || 'main moved while landing'}; land again`, EXIT.refused)
}

for (const mirror of mirrors) {
  if ((await $`git push -q ${mirror} HEAD:main`.nothrow().quiet()).exitCode !== 0)
    console.warn(`the mirror ${mirror} refused the push, so it is behind main: \`git push ${mirror} origin/main:main\` once it takes pushes again`)
}

await $`git fetch -q origin main`

const main = dirname(resolve((await $`git rev-parse --git-common-dir`.text()).trim()))
const short = head.slice(0, 7)

// The main checkout follows when it is on main, unless a change of its own in the way refuses the fast-forward: origin has the landing either way. A lockfile it moves is installed there too, or the main checkout keeps building with the packages from before.
async function followMain() {
  if ((await $`git -C ${main} symbolic-ref --short HEAD`.nothrow().text()).trim() !== 'main') {
    console.warn(`the main checkout at ${main} is not on main, so it stays where it is`)

    return
  }

  const before = (await $`git -C ${main} rev-parse HEAD`.text()).trim()

  if ((await $`git -C ${main} merge -q --ff-only ${head}`.nothrow()).exitCode !== 0) {
    console.warn(`the main checkout at ${main} could not fast-forward to ${short}: run \`git merge --ff-only origin/main\` there`)

    return
  }

  for (const lockfile of (await $`git -C ${main} diff --name-only ${before} ${head} -- bun.lock ${'bench/apps/*/bun.lock'}`.text()).split('\n').filter(Boolean)) {
    const dir = join(main, dirname(lockfile))

    if ((await $`bun install --silent --frozen-lockfile`.cwd(dir).nothrow().quiet()).exitCode !== 0)
      console.warn(`the main checkout's packages at ${dir} are behind its lockfile: run \`bun install --frozen-lockfile\` there`)
  }
}

await followMain()
await release()

console.log(`landed ${short} on main: \`just ci ${short}\` follows its CI run`)
