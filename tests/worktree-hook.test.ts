import { existsSync } from 'node:fs'
import { mkdir, realpath, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { $ } from 'bun'
import { expect, test } from 'bun:test'
import { scratchDir } from './scratch'

const HOOK = join(import.meta.dir, '..', '.claude', 'hooks', 'worktree.ts')
const PACKAGES = ['.', 'bench/apps/astro', 'bench/apps/next', 'bench/apps/nuxt', 'bench/apps/solid', 'bench/apps/svelte']

// A repository of empty packages, so each worktree's installs cost nothing.
async function emptyRepo(): Promise<string> {
  const repo = await realpath(await scratchDir('worktree-hook-'))

  await $`git init -q -b main`.cwd(repo)

  for (const dir of PACKAGES) {
    await mkdir(join(repo, dir), { recursive: true })
    await writeFile(join(repo, dir, 'package.json'), '{ "name": "empty" }\n')
    await $`${process.execPath} install --save-text-lockfile`.cwd(join(repo, dir)).quiet()
  }

  await writeFile(join(repo, '.gitignore'), 'node_modules\n.claude/worktrees\n')
  await $`git add -A && git -c user.name=t -c user.email=t@t commit -q -m init`.cwd(repo)

  return repo
}

test('worktrees created at the same time each come up usable', async () => {
  const repo = await emptyRepo()
  const names = Array.from({ length: 6 }, (_, index) => `at-once-${index}`)
  const results = await Promise.all(names.map(async name => $`${process.execPath} ${HOOK} create ${name}`.cwd(repo).quiet().nothrow()))

  expect(results.map(result => result.stderr.toString())).toEqual(names.map(() => ''))
  expect(results.map(result => result.exitCode)).toEqual(names.map(() => 0))

  for (const name of names) {
    const path = join(repo, '.claude/worktrees', name)

    expect(existsSync(join(path, 'package.json'))).toBe(true)
    expect((await $`git status --short`.cwd(path).quiet().text()).trim()).toBe('')
  }

  expect(existsSync(join(repo, '.git', 'kay-worktree.lock'))).toBe(false)
}, 60_000)

test('a worktree waits for the git steps of another to finish', async () => {
  const repo = await emptyRepo()
  const lock = join(repo, '.git', 'kay-worktree.lock')

  await mkdir(lock)

  const created = $`${process.execPath} ${HOOK} create waits`.cwd(repo).quiet().nothrow()

  await Bun.sleep(500)
  expect(existsSync(join(repo, '.claude/worktrees/waits'))).toBe(false)

  await rmdir(lock)
  expect((await created).exitCode).toBe(0)
  expect(existsSync(join(repo, '.claude/worktrees/waits/package.json'))).toBe(true)
}, 60_000)
