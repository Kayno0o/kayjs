import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { setContentPlace } from '../../../src/content/load'
import { readEdits, readLastEdit } from '../src/history'

let dir = ''

async function git(...args: string[]): Promise<void> {
  const run = Bun.spawn(['git', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@example.com', GIT_AUTHOR_DATE: '2024-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2024-01-02T00:00:00Z' } })

  await run.exited
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kcms-history-'))
  await mkdir(join(dir, 'content'), { recursive: true })
  await git('init', '-q')
  await writeFile(join(dir, 'content/a.md'), 'a')
  await git('add', '.')
  await git('commit', '-q', '-m', 'first', '--author=Ada <ada@example.com>')
  await writeFile(join(dir, 'content/b é.md'), 'b')
  await git('add', '.')
  await git('commit', '-q', '-m', 'second', '--author=Grace <grace@example.com>')
  await writeFile(join(dir, 'content/q"t.md'), 'q')
  await git('add', '.')
  await git('commit', '-q', '-m', 'third', '--author=Linus <linus@example.com>')
  await writeFile(join(dir, 'content/loose.md'), 'loose')
  setContentPlace(dir, dir)
})

afterAll(async () => {
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

it('gives the last commit touching a folder', async () => {
  expect(await readLastEdit('content')).toMatchObject({ author: 'Linus' })
  expect(await readLastEdit('nowhere')).toBeUndefined()
})
