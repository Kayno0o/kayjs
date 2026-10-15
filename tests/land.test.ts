import { join } from 'node:path'
import { $ } from 'bun'
import { describe, expect, it } from 'bun:test'
import { addedMarkers } from '../scripts/merge-markers'
import { scratchDir } from './scratch'

const ROOT = join(import.meta.dir, '..')
const MERGED = ['llms/whats-new.md', 'llms/upgrading.md', 'docs/src/content/docs/guides/whats-new.md', 'docs/src/content/docs/guides/upgrading.md']
const BASE = '# What\'s new\n\n## Unreleased\n\n- first\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'

async function git(cwd: string, ...args: string[]) {
  return $`git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false ${args}`.cwd(cwd).quiet()
}

// An origin and a clone of it holding the four merged files and the repo's own .gitattributes.
async function scratchRepo() {
  const dir = await scratchDir('land-')
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')

  await $`git init -q --bare -b main ${origin}`
  await $`git clone -q ${origin} ${work}`.quiet()

  await Bun.write(join(work, '.gitattributes'), Bun.file(join(ROOT, '.gitattributes')))

  for (const file of MERGED)
    await Bun.write(join(work, file), BASE)

  await git(work, 'add', '-A')
  await git(work, 'commit', '-qm', 'base')
  await git(work, 'push', '-q', 'origin', 'HEAD:main')

  return work
}

async function branch(work: string, name: string, change: (text: string) => string) {
  await git(work, 'checkout', '-q', '-b', name, 'origin/main')

  for (const file of MERGED)
    await Bun.write(join(work, file), change(await Bun.file(join(work, file)).text()))

  await git(work, 'commit', '-qam', name)
}

describe('merge markers', () => {
  it('finds an added marker line with its file and line, and nothing else', () => {
    const diff = ['diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -3,0 +4,3 @@', '+<<<<<<< HEAD', '+kept', '+=======', '@@ -9 +11,2 @@', '+>>>>>>> abc (msg)', '+========= a longer rule', '-=======', ''].join('\n')

    expect(addedMarkers(diff)).toEqual([
      { file: 'x.md', line: 4, text: '<<<<<<< HEAD' },
      { file: 'x.md', line: 6, text: '=======' },
      { file: 'x.md', line: 11, text: '>>>>>>> abc (msg)' },
    ])
  })
})

describe('merge markers after a line starting with ++', () => {
  it('keeps the file and the line count', () => {
    const diff = ['diff --git a/x.md b/x.md', '--- a/x.md', '+++ b/x.md', '@@ -1,0 +1,3 @@', '++ item', '+x', '+=======', ''].join('\n')

    expect(addedMarkers(diff)).toEqual([{ file: 'x.md', line: 3, text: '=======' }])
  })
})

describe('parallel landings of the whats-new and upgrading files', () => {
  it('rebases two branches adding lines under the same heading without a conflict, keeping the table intact', async () => {
    const work = await scratchRepo()

    await branch(work, 'one', text => text.replace('- first\n', '- first\n- from one\n'))
    await git(work, 'push', '-q', 'origin', 'HEAD:main')
    await branch(work, 'two', text => text.replace('- first\n', '- first\n- from two\n').replace('| 1 | 2 |\n', '| 1 | 2 |\n| 3 | 4 |\n'))
    await git(work, 'fetch', '-q', 'origin', 'main')

    const rebase = await $`git -c user.name=t -c user.email=t@example.com rebase origin/main`.cwd(work).nothrow().quiet()

    expect(rebase.exitCode).toBe(0)

    for (const file of MERGED) {
      const text = await Bun.file(join(work, file)).text()

      expect(text).toContain('- from one')
      expect(text).toContain('- from two')
      expect(text).toContain('| 1 | 2 |\n| 3 | 4 |\n')
      expect(text).not.toMatch(/^(?:<{7}|={7}|>{7})/m)
    }
  })

  it('has just land refuse a branch that adds a marker line, naming the file and line', async () => {
    const work = await scratchRepo()

    await branch(work, 'marked', text => text.replace('- first\n', '- first\n=======\n'))

    const land = await $`bun ${join(ROOT, 'scripts/land.ts')}`.cwd(work).nothrow().quiet()

    expect(land.exitCode).toBe(2)
    expect(land.stderr.toString()).toContain('llms/whats-new.md:6 (=======)')
  })
})
