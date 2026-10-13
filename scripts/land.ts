import { dirname, resolve } from 'node:path'
import { $, Glob } from 'bun'

// `just land`, which holds the landing lock: this branch rebased on origin's main, linted, checked and run through the tests its changes reach, then pushed as main, and the main checkout moved to it. The full suite is CI's, on every push.
const FIXTURE = /^tests\/fixtures\/([^/]+)\//
const PACKAGE = /^packages\/([^/]+)\//
// Read by every test file or by kay itself rather than imported, so `bun test --changed` cannot follow them.
const WHOLE_SUITE = /^(?:package\.json|bun\.lock|bunfig\.toml|tsconfig[^/]*\.json|eslint\.config\.ts|src\/(?:.*\/)?[^/]+(?<!\.ts))$/
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

if ((await $`git status --porcelain`.text()).trim() !== '')
  throw new Error('the working tree has changes: commit them first')

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

// Main may have moved the lockfile under this branch.
await $`bun install --silent --frozen-lockfile`
await $`bun run lint`
await $`bun run check`

if (changed.some(path => path.startsWith('bench/') || path === 'bun.lock')) {
  await $`bun run bench:check`
  await $`bun test ./bench -t ${'leave hydration markers'}`
}
else if (changed.some(path => path.startsWith('src/'))) {
  await $`bun run bench:check:kay`
}

if (changed.some(path => path.startsWith('.forgejo/')))
  await $`just lint-actions`

if (changed.some(path => WHOLE_SUITE.test(path))) {
  await $`bun run test ${WORKERS}`
}
else {
  await $`bun run test --changed=origin/main ${WORKERS}`

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
    await $`bun run test ${[...readers]} ${WORKERS}`
}

for (const name of new Set(changed.map(path => PACKAGE.exec(path)?.[1]).filter(name => name !== undefined))) {
  await $`bun run check`.cwd(`packages/${name}`)
  await $`bun run test`.cwd(`packages/${name}`)
}

// origin pushes to Forgejo, then mirrors to GitHub: main is Forgejo's, so only its refusal stops a landing.
const [forge, ...mirrors] = (await $`git remote get-url --push --all origin`.text()).split('\n').filter(Boolean)
const head = (await $`git rev-parse HEAD`.text()).trim()
const pushed = await $`git push -q ${forge} HEAD:main`.nothrow()

if (pushed.exitCode !== 0) {
  await $`git fetch -q origin main`

  if ((await $`git rev-parse origin/main`.text()).trim() !== head)
    throw new Error(`${forge} refused the push: ${pushed.stderr.toString().trim() || 'main moved while landing'}; land again`)
}

for (const mirror of mirrors) {
  if ((await $`git push -q ${mirror} HEAD:main`.nothrow()).exitCode !== 0)
    console.warn(`the mirror ${mirror} refused the push, so it is behind main: \`git push ${mirror} origin/main:main\` once it takes pushes again`)
}

await $`git fetch -q origin main`

const main = dirname(resolve((await $`git rev-parse --git-common-dir`.text()).trim()))
const short = head.slice(0, 7)

// The main checkout follows when it is on main, unless a change of its own in the way refuses the fast-forward: origin has the landing either way.
if ((await $`git -C ${main} symbolic-ref --short HEAD`.nothrow().text()).trim() !== 'main')
  console.warn(`the main checkout at ${main} is not on main, so it stays where it is`)
else if ((await $`git -C ${main} merge -q --ff-only ${head}`.nothrow()).exitCode !== 0)
  console.warn(`the main checkout at ${main} could not fast-forward to ${short}: run \`git merge --ff-only origin/main\` there`)

console.log(`landed ${short} on main`)
