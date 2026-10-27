import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, spyOn } from 'bun:test'
import { setContentPlace } from '../../../src/content/load'
import { readEdits, readLastEdit } from '../src/history'

let dir = ''
// How long a walk of the history takes, in seconds, as on a loaded machine, and how many walks ran since the last `walks()`.
let delay = 0
let walked = 0
const spawn = Bun.spawn
const spawned = spyOn(Bun, 'spawn').mockImplementation(((command: string[], ...rest: unknown[]) => {
  const walk = command[0] === 'git' && command.includes('log') && command.includes('-z')

  if (walk)
    walked++

  return (spawn as (...args: unknown[]) => unknown)(walk && delay > 0 ? ['sh', '-c', 'sleep "$0" && exec "$@"', String(delay), ...command] : command, ...rest)
}) as typeof Bun.spawn)

function walks(): number {
  const count = walked

  walked = 0

  return count
}

async function git(...args: string[]): Promise<void> {
  const run = spawn(['git', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z' } })

  await run.exited
}

async function commit(file: string, author: string): Promise<void> {
  await writeFile(join(dir, file), `${file} by ${author}`)
  await git('add', '.')
  await git('commit', '-q', '-m', file, `--author=${author} <${author.toLowerCase()}@example.com>`)
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kcms-history-'))
  await mkdir(join(dir, 'content/notes'), { recursive: true })
  await git('init', '-q')
  await commit('content/a.md', 'Ada')
  await commit('content/b é.md', 'Grace')
  await commit('content/q"t.md', 'Linus')
  await writeFile(join(dir, 'content/loose.md'), 'loose')
  setContentPlace(dir, dir)
})

afterAll(async () => {
  spawned.mockRestore()
  await rm(dir, { recursive: true, force: true })
})

it('reads each file\'s last commit in one go, and gives a file git does not know no date', async () => {
  const edits = await readEdits(['content/a.md', 'content/b é.md', 'content/loose.md', 'content/missing.md'])

  expect(edits.get('content/a.md')).toMatchObject({ author: 'Ada' })
  expect((await readEdits(['content/q"t.md'])).get('content/q"t.md')).toMatchObject({ author: 'Linus' })
  expect(edits.get('content/b é.md')).toMatchObject({ author: 'Grace' })
  expect(edits.has('content/loose.md')).toBe(false)
  expect(edits.has('content/missing.md')).toBe(false)
  expect(await readEdits([])).toEqual(new Map())
})

it('walks the history once per commit, however many lists read it', async () => {
  await commit('content/d.md', 'Ada')
  walks()

  expect((await readEdits(['content/d.md'])).get('content/d.md')).toMatchObject({ author: 'Ada' })
  expect((await readEdits(['content/a.md', 'content/d.md'])).get('content/a.md')).toMatchObject({ author: 'Ada' })
  expect(walks()).toBe(1)

  await commit('content/a.md', 'Grace')

  expect((await readEdits(['content/a.md'])).get('content/a.md')).toMatchObject({ author: 'Grace' })
  expect(walks()).toBe(1)
})

it('walks the collection\'s folder once, whatever subfolders a page\'s entries sit in', async () => {
  await commit('content/notes/g.md', 'Linus')
  walks()

  expect((await readEdits(['content/notes/g.md'], { dir: 'content' })).get('content/notes/g.md')).toMatchObject({ author: 'Linus' })
  expect((await readEdits(['content/a.md', 'content/notes/g.md'], { dir: 'content' })).get('content/a.md')).toMatchObject({ author: 'Grace' })
  expect((await readEdits(['content/a.md'], { dir: 'content' })).get('content/a.md')).toMatchObject({ author: 'Grace' })
  expect(walks()).toBe(1)
})

it('gives a list no dates rather than wait on a slow git, and the next list the dates that walk found', async () => {
  await commit('content/e.md', 'Grace')
  walks()
  delay = 3

  try {
    const started = performance.now()

    expect((await readEdits(['content/e.md'])).has('content/e.md')).toBe(false)
    expect(performance.now() - started).toBeLessThan(2500)
    // A sorted list waits for the same walk rather than start another.
    expect((await readEdits(['content/e.md'], { sorting: true })).get('content/e.md')).toMatchObject({ author: 'Grace' })
  }
  finally {
    delay = 0
  }

  expect((await readEdits(['content/e.md'])).get('content/e.md')).toMatchObject({ author: 'Grace' })
  expect(walks()).toBe(1)
}, 15_000)

it('waits for a slow git when the list is sorted by the dates', async () => {
  await commit('content/f.md', 'Linus')
  delay = 1.5

  try {
    expect((await readEdits(['content/f.md'], { sorting: true })).get('content/f.md')).toMatchObject({ author: 'Linus' })
  }
  finally {
    delay = 0
  }
}, 15_000)

it('gives the last commit touching a folder', async () => {
  expect(await readLastEdit('content')).toMatchObject({ author: 'Linus' })
  expect(await readLastEdit('nowhere')).toBeUndefined()
})
