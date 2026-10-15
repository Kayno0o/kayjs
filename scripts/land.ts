import { appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { $, Glob } from 'bun'
import { addedMarkers } from './merge-markers'
import { failedTests } from './test-failures'

// `just land`, which holds the landing lock: this branch rebased on origin's main, linted, checked and run through the tests its changes reach, then pushed as main, and the main checkout moved to it. The full suite is CI's, on every push, which `just ci` follows.
// It prints one line per step, their output going to a log in the worktree's git folder, and a failure ends on the step's last lines, exiting with one of EXIT's codes.
const EXIT = { unlandable: 2, conflict: 3, step: 4, refused: 5 }
const LOG = join((await $`git rev-parse --absolute-git-dir`.text()).trim(), 'land.log')
// Lines of a failing step's output shown, the rest staying in the log: its last ones, or after its failed tests only bun test's summary.
const TAIL = 30
const SUMMARY = 8
const FIXTURE = /^tests\/fixtures\/([^/]+)\//
const PACKAGE = /^packages\/([^/]+)\//
// Read by every test file or by kay itself rather than imported, so `bun test --changed` cannot follow them.
const WHOLE_SUITE = /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|eslint\.(?:config|base)\.ts|src\/(?:.*\/)?[^/]+(?<!\.ts))$/
// Tests reading these folders as files, which an import graph does not show.
const READERS: [RegExp, string[]][] = [
  [/^(?:llms\/|llms\.txt$)/, ['tests/llms.test.ts', 'tests/docs.test.ts']],
  [/^docs\//, ['tests/docs.test.ts', 'tests/docs-page-weight.test.ts']],
  [/^examples\//, ['tests/examples.test.ts', 'tests/new.test.ts', 'tests/docs.test.ts']],
  [/^packages\//, ['tests/packages.test.ts', 'tests/docs.test.ts', 'tests/docs-page-weight.test.ts', 'tests/examples.test.ts', 'tests/library.test.ts', 'tests/new.test.ts']],
  [/^tests\/fixtures\//, ['tests/format.test.ts']],
]
// Half the host's cores, as CI runs them, so a landing leaves the machine to the rest.
const WORKERS = '--parallel=6'

function fail(message: string, code: number): never {
  console.error(`land failed: ${message}`)
  process.exit(code)
}

// Runs one step with its output in the log, failing the landing on its failed tests and last lines.
async function step(label: string, command: $.ShellPromise) {
  const started = performance.now()

  process.stdout.write(`${label}: `)

  const { exitCode, stdout } = await command.nothrow().quiet()
  const output = stdout.toString()
  const seconds = Math.round((performance.now() - started) / 1000)

  await appendFile(LOG, `$ ${label}\n${output}\n`)

  if (exitCode === 0) {
    console.log(`ok, ${seconds} s`)

    return
  }

  console.log(`exit ${exitCode}, ${seconds} s`)
  const lines = output.trimEnd().split('\n')

  const failures = failedTests(lines)

  console.error([...failures, lines.slice(failures.length > 0 ? -SUMMARY : -TAIL).join('\n')].join('\n\n'))
  fail(`${label} exited with ${exitCode}: its whole output is in ${LOG}`, EXIT.step)
}

if ((await $`git status --porcelain`.text()).trim() !== '')
  fail('the working tree has changes: commit them first', EXIT.unlandable)

await Bun.write(LOG, '')
await $`git fetch -q origin main`

if ((await $`git rebase -q origin/main`.nothrow().quiet()).exitCode !== 0) {
  const conflicts = (await $`git diff --name-only --diff-filter=U`.text()).trim().split('\n').join(', ')

  await $`git rebase --abort`.nothrow().quiet()
  fail(`the branch conflicts with main in ${conflicts}: rebase it by hand, then land again`, EXIT.conflict)
}

const changed = (await $`git diff --name-only origin/main HEAD`.text()).split('\n').filter(Boolean)

if (changed.length === 0)
  fail('nothing to land: the branch is main', EXIT.unlandable)

// A rebase resolved by hand can leave a conflict marker in a file no check reads.
const markers = addedMarkers(await $`git diff --unified=0 --no-color origin/main HEAD`.text())

if (markers.length > 0)
  fail(`the branch adds merge markers: ${markers.map(({ file, line, text }) => `${file}:${line} (${text})`).join(', ')}`, EXIT.unlandable)

// Main may have moved the lockfile under this branch.
await step('bun install', $`bun install --silent --frozen-lockfile 2>&1`)
await step('lint', $`bun run lint 2>&1`)
await step('check', $`bun run check 2>&1`)

if (changed.some(path => path.startsWith('bench/') || path === 'bun.lock')) {
  await step('bench:check', $`bun run bench:check 2>&1`)
  await step('bench hydration markers', $`bun test ./bench -t ${'leave hydration markers'} 2>&1`)
}
else if (changed.some(path => path.startsWith('src/'))) {
  await step('bench:check:kay', $`bun run bench:check:kay 2>&1`)
}

if (changed.some(path => path.startsWith('.forgejo/')))
  await step('lint-actions', $`just lint-actions 2>&1`)

if (changed.some(path => WHOLE_SUITE.test(path))) {
  await step('tests, the whole suite', $`bun run test ${WORKERS} 2>&1`)
}
else {
  await step('tests the changes reach', $`bun run test --changed=origin/main ${WORKERS} 2>&1`)

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
    await step('tests reading the changed files', $`bun run test ${[...readers]} ${WORKERS} 2>&1`)
}

for (const name of new Set(changed.map(path => PACKAGE.exec(path)?.[1]).filter(name => name !== undefined))) {
  await step(`packages/${name} check`, $`bun run check 2>&1`.cwd(`packages/${name}`))
  await step(`packages/${name} tests`, $`bun run test 2>&1`.cwd(`packages/${name}`))
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

console.log(`landed ${short} on main: \`just ci ${short}\` follows its CI run`)
