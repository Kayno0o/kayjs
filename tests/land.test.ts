import { readdirSync, readlinkSync } from 'node:fs'
import { rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { $ } from 'bun'
import { describe, expect, it } from 'bun:test'
import { dependenciesOnly } from '../scripts/dependency-change'
import { librariesToTest, libraryDependencies } from '../scripts/library-dependents'
import { addedMarkers } from '../scripts/merge-markers'
import { FIXTURE_WALK, FIXTURE_WALKERS, READERS, readersOf, SOURCE_CHANGE, SOURCE_FILE_READ, SOURCE_FILE_READERS, SOURCE_READERS, SOURCE_SCAN, sourcesRead, UI_THEME_USE, WHOLE_SUITE } from '../scripts/source-readers'
import { subprocessTests } from '../scripts/subprocess-tests'
import { scratchDir } from './scratch'

const ROOT = join(import.meta.dir, '..')
const MERGED = ['llms/whats-new.md', 'llms/upgrading.md']
const BASE = '# What\'s new\n\n## Unreleased\n\n- first\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'

async function git(cwd: string, ...args: string[]) {
  return $`git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false ${args}`.cwd(cwd).quiet()
}

// An origin and a clone of it holding the two merged files and the repo's own .gitattributes.
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

    const land = await $`${process.execPath} ${join(ROOT, 'scripts/land.ts')}`.cwd(work).nothrow().quiet()

    expect(land.exitCode).toBe(2)
    expect(land.stderr.toString()).toContain('llms/whats-new.md:6 (=======)')
  })
})

const LAND = join(ROOT, 'scripts/land.ts')
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

// An origin, and for each name a clone on a branch with one commit of its own, whose lint step is `lint.ts`: it notes its run in LAND_TRACE, leaves a process of another group holding its output while LAND_LEAK is set, waits for LAND_GATE to exist and fails while LAND_FAIL is set.
// Its test step, `test.ts`, notes its arguments in LAND_TRACE; `lib.ts`, a library's test step, notes its run there too and fails while LAND_LIB_FAIL is set.
async function landings(...names: string[]) {
  const dir = await scratchDir('land-')
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  const trace = join(dir, 'trace')
  const clones: Record<string, string> = {}

  await $`git init -q --bare -b main ${origin}`
  await $`git clone -q ${origin} ${seed}`.quiet()
  await Bun.write(join(seed, 'package.json'), JSON.stringify({ name: 'landing', scripts: { lint: 'bun lint.ts', check: 'true', test: 'bun test.ts' }, peerDependencies: { 'left-pad': '^1.0.0' }, peerDependenciesMeta: { 'left-pad': { optional: true } } }, null, 2))
  await Bun.write(join(seed, 'shared.txt'), 'one\n')
  // The eager JS sizes step, which a landing runs whatever its change reaches: it fails with a growth message while LAND_SIZES_FAIL is set.
  await Bun.write(join(seed, 'scripts/sizes.ts'), 'if (process.env.LAND_SIZES_FAIL) {\n  console.error(\'Eager JS grew past 100 B: static +200 B. run `bun scripts/sizes.ts --update`\')\n  process.exit(1)\n}\n')
  // The cap step, which fails with the command to run while LAND_CAP_FAIL is set, as a page outgrowing its room does.
  await Bun.write(join(seed, 'scripts/whats-new.ts'), 'if (process.env.LAND_CAP_FAIL) {\n  console.error(\'llms/whats-new.md outgrew the room: run `bun scripts/whats-new.ts --cap`\')\n  process.exit(1)\n}\n')
  await Bun.write(join(seed, 'lint.ts'), 'import { appendFileSync, existsSync } from \'node:fs\'\n\nappendFileSync(process.env.LAND_TRACE!, `${process.env.LAND_NAME}\\n`)\n\nif (process.env.LAND_LEAK)\n  Bun.spawn([\'setsid\', \'sleep\', \'30\'], { stdout: \'inherit\', stderr: \'inherit\' }).unref()\n\nwhile (process.env.LAND_GATE && !existsSync(process.env.LAND_GATE))\n  await Bun.sleep(20)\n\nif (process.env.LAND_FAIL)\n  process.exit(1)\n')
  await Bun.write(join(seed, 'test.ts'), 'import { appendFileSync } from \'node:fs\'\n\nappendFileSync(process.env.LAND_TRACE!, `test ${process.argv.slice(2).join(\' \')}\\n`)\n')
  await Bun.write(join(seed, 'lib.ts'), 'import { appendFileSync } from \'node:fs\'\n\nappendFileSync(process.env.LAND_TRACE!, \'lib\\n\')\n\nif (process.env.LAND_LIB_FAIL)\n  process.exit(1)\n')
  await $`${process.execPath} install --silent`.cwd(seed).quiet()
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
    const child = Bun.spawn([process.execPath, LAND], { cwd: clones[name]!, env: { ...process.env, ...IDENTITY, LAND_TRACE: trace, LAND_NAME: name, ...env }, stdout: 'pipe', stderr: 'pipe' })

    let out = ''

    // Stdout is read as it comes, for a test waiting on a line of it.
    const reading = (async () => {
      for await (const chunk of child.stdout)
        out += new TextDecoder().decode(chunk)
    })()

    return {
      saying: async (text: string) => until(async () => out.includes(text)),
      done: async () => {
        const [err] = await Promise.all([new Response(child.stderr).text(), reading, child.exited])

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
    const started = Date.now()
    // A drain timer left pending after the last step would hold the landing open for its whole length.
    const { code, out } = await land('a', { KAY_LAND_DRAIN_MS: '20000' }).done()

    expect(Date.now() - started).toBeLessThan(15_000)
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

  it('verifies again when main moved, even after another worktree fetched it while this landing verified', async () => {
    const { clones, dir, land, ran, tree } = await landings('a', 'b')
    const gate = join(dir, 'gate')
    const first = land('a', { LAND_GATE: gate })

    await until(async () => await ran('a') === 1)
    expect((await land('b').done()).code).toBe(0)

    // A worktree shares its remote refs with every other one, so another landing's fetch moves origin/main under this one.
    await git(clones.a!, 'fetch', '-q', 'origin', 'main')
    await Bun.write(gate, '')

    const { code, out } = await first.done()

    expect(code).toBe(0)
    expect(out).toContain('main moved while verifying: rebasing and verifying again')
    expect(await ran('a')).toBe(2)
    expect(await tree()).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
  }, 90_000)

  it('waits for the landing lock only to push, saying so', async () => {
    const { clones, land, tree } = await landings('a')
    const holder = Bun.spawn(['flock', join(clones.a!, '.git/kay-land.lock'), 'sh', '-c', 'echo held; cat >/dev/null'], { stdin: 'pipe', stdout: 'pipe' })
    const running = land('a')

    await running.saying('waiting for another landing to finish')
    // Pushing without the lock would take no longer than this.
    await Bun.sleep(800)
    expect(await tree()).not.toContain('a.txt')
    await holder.stdin.end()

    const { code, out } = await running.done()

    expect(code).toBe(0)
    expect(out).toContain('waiting for another landing to finish')
    expect(await tree()).toContain('a.txt')
  }, 60_000)

  it('kills a step that runs past its limit with what it started, exiting 4 on it with its output up to then', async () => {
    const { clones, dir, land, ran, tree } = await landings('a')
    const started = Date.now()
    // The gate never opens, so lint waits as a hung test would.
    const { code, err } = await land('a', { LAND_GATE: join(dir, 'gate'), KAY_LAND_STEP_LIMIT_MS: '1500' }).done()
    const cwds = readdirSync('/proc').flatMap((name) => {
      try {
        return [readlinkSync(`/proc/${name}/cwd`)]
      }
      catch {
        return []
      }
    })

    expect({ code, killed: err.includes('lint ran past 1.5 s, so it was killed'), fast: Date.now() - started < 20_000 }).toEqual({ code: 4, killed: true, fast: true })
    expect(await ran('a')).toBe(1)
    // Lint's `bun run` and the script it ran are gone with it.
    expect(cwds).not.toContain(clones.a)
    expect(await tree()).not.toContain('a.txt')
  }, 60_000)

  it('lands and ends though a step left a process of another group holding its output', async () => {
    const { clones, land, tree } = await landings('a')
    const started = Date.now()

    try {
      const { code } = await land('a', { LAND_LEAK: '1', KAY_LAND_DRAIN_MS: '300' }).done()

      expect({ code, fast: Date.now() - started < 15_000 }).toEqual({ code: 0, fast: true })
      expect(await tree()).toContain('a.txt')
    }
    finally {
      for (const name of readdirSync('/proc')) {
        try {
          if (readlinkSync(`/proc/${name}/cwd`) === clones.a)
            process.kill(Number(name), 'SIGKILL')
        }
        catch {}
      }
    }
  }, 60_000)

  it('fails a step whose command cannot start with the shell\'s reason, in its summary and its log', async () => {
    const { clones, land } = await landings('a')
    // The tools a landing needs, `just` left out, which a change to the workflows runs.
    const bin = await scratchDir('land-bin-')

    for (const tool of ['bun', 'git', 'sh', 'flock', 'cat', 'true'])
      await symlink(tool === 'bun' ? process.execPath : Bun.which(tool)!, join(bin, tool))

    await Bun.write(join(clones.a!, '.forgejo/workflows/test.yml'), 'on: push\n')
    await git(clones.a!, 'add', '-A')
    await git(clones.a!, 'commit', '-qm', 'workflow')

    const { code, err } = await land('a', { PATH: bin }).done()
    const log = await Bun.file(join(clones.a!, '.git/land.log')).text()

    expect({ code, summary: err.includes('just: not found'), log: log.includes('just: not found') }).toEqual({ code: 4, summary: true, log: true })
  }, 60_000)

  it('stops before the push on an eager JS growth, with the page and the command accepting it, whatever the change reaches', async () => {
    const { land, tree } = await landings('a')
    const { code, out, err } = await land('a', { LAND_SIZES_FAIL: '1' }).done()

    expect(code).toBe(4)
    expect(out).toContain('eager JS sizes: exit 1')
    expect(err).toContain('static +200 B')
    expect(err).toContain('bun scripts/sizes.ts --update')
    expect(await tree()).not.toContain('a.txt')
  }, 60_000)

  it('stops before lint on a page past its cap, naming the command that cuts it, which a landing never runs on the branch', async () => {
    const { land, tree } = await landings('a')
    const { code, out, err } = await land('a', { LAND_CAP_FAIL: '1' }).done()

    expect(code).toBe(4)
    expect(out).toContain('whats-new cap: exit 1')
    expect(out).not.toContain('lint:')
    expect(err).toContain('bun scripts/whats-new.ts --cap')
    expect(await tree()).not.toContain('a.txt')
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

describe('landing a change to dependencies alone', () => {
  it('leaves the whole suite to CI and runs the test holding the manifests together', async () => {
    const { clones, land, tree } = await landings('a')
    const work = clones.a!

    await git(work, 'reset', '-q', '--hard', 'origin/main')
    await Bun.write(join(work, 'package.json'), (await Bun.file(join(work, 'package.json')).text()).replace('^1.0.0', '^1.1.0'))
    await git(work, 'commit', '-qam', 'peer')

    const { code, out } = await land('a').done()
    const trace = await Bun.file(join(work, '..', 'trace')).text()

    expect(code).toBe(0)
    expect(out).toContain('tests, the whole suite: left to CI, as only dependencies changed')
    expect(trace).toMatch(/^test .*tests\/packages\.test\.ts/m)
    expect(trace).not.toContain('--changed')
    expect(await tree()).toContain('package.json')
  }, 60_000)

  it('runs the whole suite for a manifest changing more than its dependencies', async () => {
    const { clones, land } = await landings('a')
    const work = clones.a!

    await Bun.write(join(work, 'package.json'), (await Bun.file(join(work, 'package.json')).text()).replace('"landing"', '"landed"'))
    await git(work, 'commit', '-qam', 'name')

    const { code, out } = await land('a').done()

    expect(code).toBe(0)
    expect(out).toContain('tests, the whole suite: ok')
    expect(out).not.toContain('left to CI')
  }, 60_000)
})

describe('landing a change to a library', () => {
  async function library(work: string) {
    await Bun.write(join(work, 'packages/lib/package.json'), JSON.stringify({ name: 'lib', scripts: { check: 'true', test: 'bun ../../lib.ts' } }))
    await git(work, 'add', '-A')
    await git(work, 'commit', '-qm', 'lib')
  }

  // Each library's suite fills the workers on its own, so beside kay's tests it would double the processes and the memory a landing takes.
  it('runs the library\'s suite once kay\'s tests are done, a line each', async () => {
    const { clones, dir, land, tree } = await landings('a')

    await library(clones.a!)

    const { code, out } = await land('a').done()
    const trace = (await Bun.file(join(dir, 'trace')).text()).split('\n').filter(line => line === 'lib' || line.startsWith('test '))

    expect(code).toBe(0)
    expect(out).toMatch(/^tests the changes reach: ok, \d+ s$/m)
    expect(out).toMatch(/^packages\/lib tests: ok, \d+ s$/m)
    expect(trace.at(-1)).toBe('lib')
    expect(trace.length).toBeGreaterThan(1)
    expect(await tree()).toContain('packages')
  }, 60_000)

  it('stops on the library\'s failing suite, exiting 4', async () => {
    const { clones, land, tree } = await landings('a')

    await library(clones.a!)

    const { code, out } = await land('a', { LAND_LIB_FAIL: '1' }).done()

    expect(code).toBe(4)
    expect(out).toContain('packages/lib tests: exit 1')
    expect(await tree()).not.toContain('packages')
  }, 60_000)
})

describe('the libraries a landing tests', () => {
  const DEPENDENCIES = new Map([['ui', new Set<string>()], ['cms', new Set(['ui', 'mail'])], ['ai', new Set(['ui'])], ['mail', new Set<string>()]])

  it('reads which library names which in its manifest', async () => {
    const found = await libraryDependencies(ROOT)

    expect([...found.get('cms') ?? []]).toContain('ui')
    expect([...found.get('ai') ?? []]).toContain('ui')
    expect([...found.get('ui') ?? []]).not.toContain('ui')
  })

  it('adds the dependents of a library whose source changed', () => {
    expect(librariesToTest(['packages/ui/src/button.kay'], DEPENDENCIES).toSorted()).toEqual(['ai', 'cms', 'ui'])
    expect(librariesToTest(['packages/mail/src/send.ts'], DEPENDENCIES).toSorted()).toEqual(['cms', 'mail'])
  })

  it('leaves the dependents out for a change to tests or docs alone', () => {
    expect(librariesToTest(['packages/ui/tests/button.test.ts', 'packages/ui/llms.txt'], DEPENDENCIES)).toEqual(['ui'])
    expect(librariesToTest(['src/server/env.ts'], DEPENDENCIES)).toEqual([])
  })

  it('follows a dependent\'s own dependents', () => {
    const chain = new Map([['a', new Set<string>()], ['b', new Set(['a'])], ['c', new Set(['b'])]])

    expect(librariesToTest(['packages/a/src/x.ts'], chain).toSorted()).toEqual(['a', 'b', 'c'])
  })
})

describe('a change to dependencies alone', () => {
  const MANIFEST = JSON.stringify({ name: 'x', scripts: { test: 'bun test' }, dependencies: { a: '^1.0.0' } }, null, 2)

  it('is a lockfile, or a manifest whose other fields stayed as they were', () => {
    expect(dependenciesOnly('bun.lock', 'old', 'new')).toBe(true)
    expect(dependenciesOnly('bench/apps/next/bun.lock', 'old', 'new')).toBe(true)
    expect(dependenciesOnly('package.json', MANIFEST, MANIFEST.replace('^1.0.0', '^1.2.0'))).toBe(true)
    expect(dependenciesOnly('packages/ui/package.json', MANIFEST, MANIFEST.replace('"dependencies"', '"devDependencies"'))).toBe(true)
  })

  it('is not a manifest changing another field, one added or removed, one that does not parse, or another file', () => {
    expect(dependenciesOnly('package.json', MANIFEST, MANIFEST.replace('bun test', 'bun test --bail'))).toBe(false)
    expect(dependenciesOnly('package.json', undefined, MANIFEST)).toBe(false)
    expect(dependenciesOnly('package.json', MANIFEST, undefined)).toBe(false)
    expect(dependenciesOnly('package.json', '{', MANIFEST)).toBe(false)
    expect(dependenciesOnly('tsconfig.json', '{}', '{"a":1}')).toBe(false)
  })
})

describe('tests running kay in a subprocess', () => {
  it('are reached by a change to a module their subprocess loads, though no import shows it', async () => {
    expect(await subprocessTests(ROOT, ['src/server/i18n.ts'])).toContain('tests/check-load.test.ts')
  })

  it('are left out for a change their subprocess does not load, and for one outside src', async () => {
    expect(await subprocessTests(ROOT, ['src/runtime/dom.ts'])).not.toContain('tests/check-load.test.ts')
    expect(await subprocessTests(ROOT, ['llms/lints.md'])).toEqual([])
  })

  it('leave out a test whose own imports already reach the change', async () => {
    expect(await subprocessTests(ROOT, ['src/check/index.ts'])).not.toContain('tests/check.test.ts')
  })
})

const THEME = 'packages/ui/src/theme.css'

describe('tests scanning the sources as files', () => {
  it('are all listed, so a landing changing a source runs them', async () => {
    const scanning: string[] = []

    for await (const test of new Bun.Glob('tests/*.test.ts').scan(ROOT)) {
      if (SOURCE_SCAN.test(await Bun.file(join(ROOT, test)).text()))
        scanning.push(test)
    }

    expect(scanning.toSorted()).toEqual([...SOURCE_READERS].toSorted())
  })

  it('are run for a source file another test reads through a fixed path', async () => {
    const unreached: string[] = []

    for await (const test of new Bun.Glob('tests/*.test.ts').scan(ROOT)) {
      for (const [, path] of (await Bun.file(join(ROOT, test)).text()).matchAll(SOURCE_FILE_READ)) {
        const sources = await sourcesRead(path!, ROOT)

        // A built path matching no file would pass unchecked, as a renamed folder would leave it.
        if (sources.length === 0)
          unreached.push(`${test} reads ${path} which matches no file`)

        for (const source of sources) {
          // A kay source other than a `.ts` already runs the whole suite.
          if (!WHOLE_SUITE.test(source) && !readersOf(source).includes(test))
            unreached.push(`${test} reads ${source}`)
        }
      }
    }

    expect(unreached.toSorted()).toEqual([])
  })

  it('read a built path as every file it can name, none when it names no file', async () => {
    expect(await sourcesRead('../packages/ui/src/${name}.kay', ROOT)).toContain('packages/ui/src/bell.kay')
    expect(await sourcesRead('../packages/ui/src/bell.kay', ROOT)).toEqual(['packages/ui/src/bell.kay'])
    expect(await sourcesRead('../packages/ui/nope/${name}.kay', ROOT)).toEqual([])
  })

  it('list for the theme of the UI library the tests reading it or loading the UI extension, no more and no less', async () => {
    const using: string[] = []

    for await (const test of new Bun.Glob('tests/*.test.ts').scan(ROOT)) {
      if (test !== 'tests/land.test.ts' && !test.includes('browser') && UI_THEME_USE.test(await Bun.file(join(ROOT, test)).text()))
        using.push(test)
    }

    // The broad entries (a folder of tests, every file) are left out: they run these tests for any change, whether or not they use the theme.
    const specific = SOURCE_FILE_READERS.flatMap(([folder, tests]) => folder.test(THEME) ? tests : [])
    const broad = new Set(READERS.filter(entry => !SOURCE_FILE_READERS.includes(entry)).flatMap(([folder, tests]) => folder.test(THEME) ? tests : []))
    const expected = using.filter(test => !broad.has(test))

    expect({ missing: expected.filter(test => !specific.includes(test)).toSorted(), extra: specific.filter(test => !using.includes(test)).toSorted() }).toEqual({ missing: [], extra: [] })
  })

  it('run the tests reading the theme of the UI library for a change to it, and no browser one', () => {
    const tests = readersOf('packages/ui/src/theme.css')

    expect(tests).toContain('tests/apply-theme.test.ts')
    expect(tests.filter(test => (/browser|docs-contrast/).test(test))).toEqual([])
    expect(readersOf('packages/ui/src/button.kay')).not.toContain('tests/apply-theme.test.ts')
  })

  it('are reached by a source of kay or of a library, and by nothing else', () => {
    for (const path of ['src/server/preview.ts', 'src/runtime/dom.ts', 'packages/ui/src/button.kay', 'packages/cms/src/server/pg-store.ts'])
      expect(SOURCE_CHANGE.test(path)).toBe(true)

    for (const path of ['llms/lints.md', 'tests/land.test.ts', 'packages/ui/llms.txt', 'packages/ui/tests/button.test.ts', 'src/server/codec/avif-enc.wasm'])
      expect(SOURCE_CHANGE.test(path)).toBe(false)
  })
})

describe('tests walking every fixture as files', () => {
  it('are all listed, so a landing adding a fixture runs them', async () => {
    const walking: string[] = []

    for await (const test of new Bun.Glob('tests/*.test.ts').scan(ROOT)) {
      if (FIXTURE_WALK.test(await Bun.file(join(ROOT, test)).text()))
        walking.push(test)
    }

    expect(walking.toSorted()).toEqual([...FIXTURE_WALKERS].toSorted())
  })

  it('run, with a build rooted at the repo, for a file of a fixture no test names', () => {
    expect(readersOf('tests/fixtures/added/src/routes/index.kay')).toEqual(expect.arrayContaining([...FIXTURE_WALKERS, 'tests/navigation.test.ts']))
    expect(readersOf('tests/land.test.ts')).not.toContain('tests/local-bundle.test.ts')
  })
})
