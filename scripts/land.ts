import { dirname, resolve } from 'node:path'
import { $, Glob } from 'bun'

// `just land`, which holds the landing lock: this branch rebased on origin's main, linted, checked and run through the tests its changes reach, then pushed as main, and the main checkout moved to it. The full suite is CI's, on every push.
const FIXTURE = /^tests\/fixtures\/([^/]+)\//
const PACKAGE = /^packages\/([^/]+)\//
// Read by every test file or by kay itself rather than imported, so `bun test --changed` cannot follow them.
const WHOLE_SUITE = /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|eslint\.config\.ts|src\/.*\.(?!ts$)[^./]+)$/
// Tests reading these folders as files, which an import graph does not show.
const READERS: [RegExp, string[]][] = [
  [/^(?:llms\/|llms\.txt$)/, ['tests/llms.test.ts']],
  [/^docs\//, ['tests/docs.test.ts']],
  [/^examples\//, ['tests/examples.test.ts', 'tests/new.test.ts']],
]
const TEST_FLAGS = ['--timeout=20000', '--timings=tests/timings.json']

if ((await $`git status --porcelain`.text()).trim() !== '')
  throw new Error('the working tree has changes: commit them first')

const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()

await $`git fetch -q origin main`

try {
  await $`git rebase -q origin/main`
}
catch {
  await $`git rebase --abort`.nothrow()

  throw new Error('the branch conflicts with main: rebase it by hand, then land again')
}

const changed = (await $`git diff --name-only origin/main HEAD`.text()).split('\n').filter(Boolean)

if (changed.length === 0)
  throw new Error('nothing to land: the branch is main')

await $`bun run lint`
await $`bun run check`

if (changed.some(path => path.startsWith('bench/') || path === 'bun.lock'))
  await $`bun run bench:check`
else if (changed.some(path => path.startsWith('src/')))
  await $`bun run bench:check:kay`

if (changed.some(path => path.startsWith('.forgejo/')))
  await $`just lint-actions`

if (changed.some(path => WHOLE_SUITE.test(path))) {
  await $`bun run test`
}
else {
  await $`bun test --parallel --changed=origin/main ${TEST_FLAGS}`

  const readers = new Set(READERS.flatMap(([folder, tests]) => changed.some(path => folder.test(path)) ? tests : []))

  const fixtures = [...new Set(changed.map(path => FIXTURE.exec(path)?.[1]).filter(name => name !== undefined))]

  if (fixtures.length > 0) {
    for await (const test of new Glob('tests/*.test.ts').scan()) {
      const text = await Bun.file(test).text()

      if (fixtures.some(name => text.includes(`fixtures/${name}`) || text.includes(`fixtureCopy('${name}')`)))
        readers.add(test)
    }
  }

  if (readers.size > 0)
    await $`bun test --parallel ${[...readers]} ${TEST_FLAGS}`
}

for (const name of new Set(changed.map(path => PACKAGE.exec(path)?.[1]).filter(name => name !== undefined))) {
  await $`bun run check`.cwd(`packages/${name}`)
  await $`bun run test`.cwd(`packages/${name}`)
}

try {
  await $`git push -q origin HEAD:main`
}
catch {
  throw new Error('origin\'s main moved while landing: land again')
}

const head = (await $`git rev-parse --short HEAD`.text()).trim()
const main = dirname(resolve((await $`git rev-parse --git-common-dir`.text()).trim()))

// The main checkout follows, unless a change of its own in the way refuses the fast-forward: origin has the landing either way.
if (branch !== 'main' && (await $`git -C ${main} merge -q --ff-only ${branch}`.nothrow()).exitCode !== 0)
  console.warn(`the main checkout at ${main} could not fast-forward to ${head}: run \`git merge --ff-only origin/main\` there`)

console.log(`landed ${head} on main`)
