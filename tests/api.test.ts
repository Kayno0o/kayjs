import { existsSync } from 'node:fs'
import { Glob } from 'bun'
import { expect, it } from 'bun:test'
import { compare, snapshots } from '../scripts/api'

const root = process.cwd()

// The public surface of kay and each library is committed in `api/`, so a change to a name or a type an app imports shows in the diff and cannot reach an npm `^` range by accident.
it('matches the committed API snapshot', async () => {
  const current = await snapshots(root)
  const problems: string[] = []

  for (const [path, text] of current) {
    const committed = existsSync(path) ? await Bun.file(path).text() : ''
    const { added, removed, changed } = compare(committed, text)

    problems.push(...removed.map(key => `removed ${path} ${key}`), ...changed.map(key => `changed ${path} ${key}`), ...added.map(key => `added ${path} ${key}`))
  }

  expect(problems, 'the public API differs from api/: run `bun scripts/api.ts --update` and commit it; a removed or changed export also needs `--breaking` and its line in llms/upgrading.md').toEqual([])
}, 60_000)

// The shadows the components' props are read from come from the libraries' sources, which a change to one must reach this test through.
it('has components to read props from', () => {
  expect([...new Glob('packages/ui/src/*.kay').scanSync()].length).toBeGreaterThan(0)
})
