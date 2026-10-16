import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
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

const LAND = join(ROOT, 'scripts/land.ts')
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

// An origin, and for each name a clone on a branch with one commit of its own, whose lint step is `lint.ts`: it notes its run in LAND_TRACE, waits for LAND_GATE to exist and fails while LAND_FAIL is set.
async function landings(...names: string[]) {
  const dir = await scratchDir('land-')
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  const trace = join(dir, 'trace')
  const clones: Record<string, string> = {}

  await $`git init -q --bare -b main ${origin}`
  await $`git clone -q ${origin} ${seed}`.quiet()
  await Bun.write(join(seed, 'package.json'), JSON.stringify({ name: 'landing', scripts: { lint: 'bun lint.ts', check: 'true', test: 'true' } }))
  await Bun.write(join(seed, 'shared.txt'), 'one\n')
  await Bun.write(join(seed, 'lint.ts'), 'import { appendFileSync, existsSync } from \'node:fs\'\n\nappendFileSync(process.env.LAND_TRACE!, `${process.env.LAND_NAME}\\n`)\n\nwhile (process.env.LAND_GATE && !existsSync(process.env.LAND_GATE))\n  await Bun.sleep(20)\n\nif (process.env.LAND_FAIL)\n  process.exit(1)\n')
  await $`bun install --silent`.cwd(seed).quiet()
  await git(seed, 'add', '-A')
  await git(seed, 'commit', '-qm', 'base')
  await git(seed, 'push', '-q', 'origin', 'HEAD:main')

  for (const name of names) {
    clones[name] = join(dir, name)
    await $`git clone -q ${origin} ${clones[name]}`.quiet()
    await git(clones[name], 'checkout', '-q', '-b', name)
    await Bun.write(join(clones[name], `${name}.txt`), `${name}\n`)
    await git(clones[name], 'add', '-A')
    await git(clones[name], 'commit', '-qm', name)
  }

  // Runs a landing in a clone, its output and exit code once it ends; its rebase commits, so it gets an identity CI's git has none of.
  const land = (name: string, env: Record<string, string> = {}) => {
    const child = Bun.spawn(['bun', LAND], { cwd: clones[name]!, env: { ...process.env, ...IDENTITY, LAND_TRACE: trace, LAND_NAME: name, ...env }, stdout: 'pipe', stderr: 'pipe' })

    return {
      done: async () => {
        const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

        return { code: child.exitCode, out, err }
      },
    }
  }

  const ran = async (name: string) => (await Bun.file(trace).exists() ? (await Bun.file(trace).text()).split('\n').filter(line => line === name).length : 0)
  const tree = async () => (await $`git --git-dir ${origin} ls-tree --name-only main`.text()).split('\n')

  return { dir, origin, clones, land, ran, tree }
}

async function until(condition: () => Promise<boolean>) {
  for (const start = Date.now(); !await condition(); await Bun.sleep(20)) {
    if (Date.now() - start > 30_000)
      throw new Error('timed out')
  }
}

describe('landing', () => {
  it('pushes at once when origin\'s main stayed where the rebase left it, and keeps the output a line per step', async () => {
    const { land, ran, tree } = await landings('a')
    const { code, out } = await land('a').done()

    expect(code).toBe(0)
    expect(out).toContain('lint: ok')
    expect(out).toMatch(/landed [0-9a-f]{7} on main/)
    expect(out).not.toContain('moved')
    expect(await ran('a')).toBe(1)
    expect(await tree()).toContain('a.txt')
  }, 60_000)

  it('verifies beside a landing that is still verifying, which then rebases and verifies again once main moved', async () => {
    const { dir, land, ran, tree } = await landings('a', 'b')
    const gate = join(dir, 'gate')
    const first = land('a', { LAND_GATE: gate })

    await until(async () => await ran('a') === 1)

    const second = await land('b').done()

    expect(second.code).toBe(0)
    expect(await tree()).toContain('b.txt')

    await Bun.write(gate, '')

    const { code, out } = await first.done()

    expect(code).toBe(0)
    expect(out).toContain('main moved while verifying: rebasing and verifying again')
    expect(await ran('a')).toBe(2)
    expect(await ran('b')).toBe(1)
    expect(await tree()).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
  }, 90_000)

  it('waits for the landing lock only to push, saying so', async () => {
    const { clones, land, tree } = await landings('a')
    const holder = Bun.spawn(['flock', join(clones.a!, '.git/kay-land.lock'), 'sh', '-c', 'echo held; cat >/dev/null'], { stdin: 'pipe', stdout: 'pipe' })
    const running = land('a')

    await Bun.sleep(1500)
    expect(await tree()).not.toContain('a.txt')
    await holder.stdin.end()

    const { code, out } = await running.done()

    expect(code).toBe(0)
    expect(out).toContain('waiting for another landing to finish')
    expect(await tree()).toContain('a.txt')
  }, 60_000)

  it('keeps its exit codes: 2 for nothing to land or changes, 3 for a conflict, 4 for a failed step, 5 for a refused push', async () => {
    const { origin, clones, land } = await landings('a', 'b', 'c')

    // A failed step.
    expect((await land('a', { LAND_FAIL: '1' }).done()).code).toBe(4)

    // Uncommitted changes.
    await Bun.write(join(clones.a!, 'dirty.txt'), 'x\n')
    expect((await land('a').done()).code).toBe(2)
    await rm(join(clones.a!, 'dirty.txt'))

    // A conflict with main.
    await Bun.write(join(clones.b!, 'shared.txt'), 'b\n')
    await git(clones.b!, 'commit', '-qam', 'b shared')
    await Bun.write(join(clones.c!, 'shared.txt'), 'c\n')
    await git(clones.c!, 'commit', '-qam', 'c shared')
    expect((await land('b').done()).code).toBe(0)
    expect((await land('c').done()).code).toBe(3)

    // Nothing to land: the branch is main.
    await git(clones.c!, 'checkout', '-q', '-B', 'main', 'origin/main')
    expect((await land('c').done()).code).toBe(2)

    // A push origin refuses.
    await Bun.write(join(origin, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n')
    await $`chmod +x ${join(origin, 'hooks/pre-receive')}`
    expect((await land('a').done()).code).toBe(5)
  }, 120_000)
})
