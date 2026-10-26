import type { DependencyChange, UpgradeDeps } from '../src/commands/upgrade'
import { chmod, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test'
import { registryDepsFor, steppingStones, upgradeProject } from '../src/commands/upgrade'
import { DEPRECATION_MINORS, LINTS, minorOf } from '../src/compiler/lints'
import { scratchDir } from './scratch'

setDefaultTimeout(90_000)

const CLI = join(import.meta.dir, '../src/cli.ts')
const MANIFEST = `{
  "name": "app",
  "dependencies": {
    "@kaynooo/kayjs-ui": "^1.40.2",
    "elysia": "^1.4.0",
    "local-lib": "workspace:*"
  },
  "devDependencies": {
    "kay": "npm:@kaynooo/kayjs@~1.40.1"
  }
}
`

// A project whose installed kay is a link to this checkout's, so the install the fakes stand in for leaves one to run.
async function project(manifest = MANIFEST, files: Record<string, string> = {}): Promise<string> {
  const root = await scratchDir('upgrade-')

  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(import.meta.dir, '..'), join(root, 'node_modules/kay'))
  await Promise.all(Object.entries({ 'package.json': manifest, ...files }).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

interface Calls {
  installs: DependencyChange[][]
  kay: string[][]
}

// The registry answers `versions`, the install always succeeds, and the project's kay lists `deprecations` and answers each check with `code`.
function fakes(versions: Record<string, string>, deprecations: string[] = [], code = 0): { deps: UpgradeDeps, calls: Calls } {
  const calls: Calls = { installs: [], kay: [] }
  const deps: UpgradeDeps = {
    latest: async name => versions[name],
    install: async (_root, changes) => {
      calls.installs.push(changes)

      return true
    },
    kay: async (_root, args) => {
      calls.kay.push(args)

      return { code: args[0] === 'explain' ? 0 : code, stdout: args[0] === 'explain' ? JSON.stringify({ lints: deprecations.map(since => ({ since })) }) : '' }
    },
  }

  return { deps, calls }
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = spyOn(console, 'log').mockImplementation(() => undefined)
  const error = spyOn(console, 'error').mockImplementation(() => undefined)

  try {
    return await run()
  }
  finally {
    log.mockRestore()
    error.mockRestore()
  }
}

describe('kay upgrade', () => {
  it('runs each check knowing the version the app came from', async () => {
    const root = await project()
    const { deps } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }, ['1.45'])
    const envs: (Record<string, string> | undefined)[] = []
    const kay = deps.kay

    deps.kay = async (dir, args, capture, env) => {
      if (args[0] === 'check')
        envs.push(env)

      return kay(dir, args, capture, env)
    }

    try {
      await quietly(async () => upgradeProject(root, deps))
      expect(envs).toEqual([{ KAY_UPGRADE_FROM: '1.40.1' }, { KAY_UPGRADE_FROM: '1.40.1' }])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('moves the ranges of kay and its libraries, each in its own section and form, and leaves the rest as it was', async () => {
    const root = await project()
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' })

    try {
      expect(await quietly(async () => upgradeProject(root, deps))).toBe(0)
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(MANIFEST.replace('^1.40.2', '~1.46.0').replace('npm:@kaynooo/kayjs@~1.40.1', 'npm:@kaynooo/kayjs@~1.46.0'))
      expect(calls.installs).toEqual([[
        { name: '@kaynooo/kayjs-ui', spec: '~1.46.0', section: 'dependencies' },
        { name: 'kay', spec: 'npm:@kaynooo/kayjs@~1.46.0', section: 'devDependencies' },
      ]])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists what it would move on --dry-run, writing, installing and rewriting nothing', async () => {
    const root = await project()
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }, ['1.44'])
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      expect(await upgradeProject(root, deps, { dryRun: true })).toBe(0)

      const printed = log.mock.calls.map(call => String(call[0])).join('\n')

      expect(printed).toContain('@kaynooo/kayjs-ui')
      expect(printed).toContain('~1.46.0')
      expect(printed).toContain('kay')
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(MANIFEST)
      expect(calls).toEqual({ installs: [], kay: [] })
    }
    finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('says --dry-run has nothing to move for an app on the latest', async () => {
    const root = await project()
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.40.1', '@kaynooo/kayjs-ui': '1.39.0' })

    try {
      expect(await quietly(async () => upgradeProject(root, deps, { dryRun: true }))).toBe(0)
      expect(calls).toEqual({ installs: [], kay: [] })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies the fixes of each minor it crosses in order, then fixes and reports the rest', async () => {
    const root = await project()
    // 1.38 is behind the app, 1.48 ahead of the version it moves to.
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }, ['1.44', '1.38', '1.41', '1.44', '1.48', '1.46'])

    try {
      await quietly(async () => upgradeProject(root, deps))
      expect(calls.kay).toEqual([
        ['explain', 'deprecated', '--format', 'json'],
        ['check', '--fix', '--since', '1.41'],
        ['check', '--fix', '--since', '1.44'],
        ['check', '--fix', '--since', '1.46'],
        ['check', '--fix', '--deny-warnings'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('announces no step and passes --quiet on to its checks with --quiet', async () => {
    const root = await project()
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }, ['1.44'])
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      expect(await upgradeProject(root, deps, { quiet: true })).toBe(0)
      expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/moved|rewriting|checking/)
      expect(calls.kay.slice(1)).toEqual([['check', '--fix', '--since', '1.44', '--quiet'], ['check', '--fix', '--deny-warnings', '--quiet']])
    }
    finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not say nothing is left while the last check still reports warnings', async () => {
    const root = await project()
    const { deps } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' })
    const kay = deps.kay
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    // Only a warning is left: the check exits 0 unless it is told warnings fail.
    deps.kay = async (dir, args, capture, env) => (args[0] === 'check' && args.includes('--deny-warnings') ? { code: 1, stdout: '' } : kay(dir, args, capture, env))

    try {
      expect(await upgradeProject(root, deps)).toBe(1)
      expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('nothing left')
    }
    finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails, as the last check does, while something is left for the app', async () => {
    const root = await project()

    try {
      expect(await quietly(async () => upgradeProject(root, fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }, [], 1).deps))).toBe(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does nothing for an app on the latest, and never moves one back', async () => {
    const root = await project()
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.40.1', '@kaynooo/kayjs-ui': '1.39.0' })

    try {
      expect(await quietly(async () => upgradeProject(root, deps))).toBe(0)
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(MANIFEST)
      expect(calls).toEqual({ installs: [], kay: [] })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops, putting package.json back, when the install fails or the registry answers nothing', async () => {
    const root = await project()
    const failing = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }, ['1.44'])
    const unreachable = fakes({ '@kaynooo/kayjs': '1.46.0' })

    failing.deps.install = async () => false

    try {
      expect(await quietly(async () => upgradeProject(root, failing.deps))).toBe(1)
      expect(failing.calls.kay).toEqual([])
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(MANIFEST)
      expect(await quietly(async () => upgradeProject(root, unreachable.deps))).toBe(1)
      expect(unreachable.calls.installs).toEqual([])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('moves the range in the section listing it, not one like it in overrides', async () => {
    const manifest = MANIFEST.replace('  "devDependencies"', '  "overrides": { "kay": "npm:@kaynooo/kayjs@~1.40.1" },\n  "devDependencies"')
    const root = await project(manifest)

    try {
      await quietly(async () => upgradeProject(root, fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' }).deps))
      expect(await Bun.file(join(root, 'package.json')).text()).toContain('"overrides": { "kay": "npm:@kaynooo/kayjs@~1.40.1" }')
      expect(await Bun.file(join(root, 'package.json')).text()).toContain('"kay": "npm:@kaynooo/kayjs@~1.46.0"')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a project with no kay range to move', async () => {
    const root = await project('{ "dependencies": { "kay": "file:vendor/kay.tgz" } }\n')

    try {
      expect(await quietly(async () => upgradeProject(root, fakes({}).deps))).toBe(1)
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// An app with its kay and kayjs-ui ranges pinned at `from`.
function appOn(from: string): string {
  return `{
  "dependencies": { "@kaynooo/kayjs-ui": "~${from}" },
  "devDependencies": { "kay": "npm:@kaynooo/kayjs@~${from}" }
}
`
}

describe('kay upgrade across removed deprecations', () => {
  it('installs the minor before each release that dropped a fix the app needs, rewriting there, then the latest', async () => {
    const root = await project(appOn('1.70.2'))
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.77.2', '@kaynooo/kayjs-ui': '1.77.2' }, ['1.71', '1.72', '1.74'])
    const envs: (Record<string, string> | undefined)[] = []
    const kay = deps.kay

    deps.kay = async (dir, args, capture, env) => {
      if (args[0] === 'check')
        envs.push(env)

      return kay(dir, args, capture, env)
    }

    try {
      expect(await quietly(async () => upgradeProject(root, deps))).toBe(0)
      expect(calls.installs.map(changes => changes.map(change => change.spec))).toEqual([
        ['~1.73.0', 'npm:@kaynooo/kayjs@~1.73.0'],
        ['~1.76.0', 'npm:@kaynooo/kayjs@~1.76.0'],
        ['~1.77.2', 'npm:@kaynooo/kayjs@~1.77.2'],
      ])
      expect(calls.kay.filter(args => args[0] === 'check')).toEqual([['check', '--fix', '--since', '1.71'], ['check', '--fix', '--since', '1.72'], ['check', '--fix', '--since', '1.74'], ['check', '--fix', '--deny-warnings']])
      expect(new Set(envs.map(env => env?.KAY_UPGRADE_FROM))).toEqual(new Set(['1.70.2']))
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(appOn('1.77.2'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rewrites each phase with the deprecations of the kay installed then, none from before the app or past the phase', async () => {
    const root = await project(appOn('1.70.2'))
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.76.0', '@kaynooo/kayjs-ui': '1.76.0' }, ['1.69', '1.71', '1.74', '1.75'])

    try {
      await quietly(async () => upgradeProject(root, deps))
      // Stone 1.73 holds 1.71; the latest 1.76 holds 1.74 and 1.75.
      expect(calls.kay.filter(args => args[0] === 'check')).toEqual([['check', '--fix', '--since', '1.71'], ['check', '--fix', '--since', '1.74'], ['check', '--fix', '--since', '1.75'], ['check', '--fix', '--deny-warnings']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes one stop from 1.73, and none from an app past every form a release dropped', async () => {
    const from173 = await project(appOn('1.73.0'))
    const from175 = await project(appOn('1.75.0'))
    const a = fakes({ '@kaynooo/kayjs': '1.77.0', '@kaynooo/kayjs-ui': '1.77.0' })
    const b = fakes({ '@kaynooo/kayjs': '1.77.0', '@kaynooo/kayjs-ui': '1.77.0' })

    try {
      await quietly(async () => upgradeProject(from173, a.deps))
      await quietly(async () => upgradeProject(from175, b.deps))
      expect(a.calls.installs.map(changes => changes[0]!.spec)).toEqual(['~1.76.0', '~1.77.0'])
      expect(b.calls.installs.map(changes => changes[0]!.spec)).toEqual(['~1.77.0'])
    }
    finally {
      await rm(from173, { recursive: true, force: true })
      await rm(from175, { recursive: true, force: true })
    }
  })

  it('does not stop at a release newer than the one it moves to', async () => {
    const root = await project(appOn('1.70.0'))
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.73.4', '@kaynooo/kayjs-ui': '1.73.4' })

    try {
      await quietly(async () => upgradeProject(root, deps))
      expect(calls.installs.map(changes => changes[0]!.spec)).toEqual(['~1.73.4'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('moves a library behind the stop to it, and leaves one already past it', async () => {
    const manifest = `{
  "dependencies": { "@kaynooo/kayjs-ui": "~1.70.0", "@kaynooo/kayjs-mail": "~1.74.1" },
  "devDependencies": { "kay": "npm:@kaynooo/kayjs@~1.70.0" }
}
`
    const root = await project(manifest)
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.75.0', '@kaynooo/kayjs-ui': '1.75.0', '@kaynooo/kayjs-mail': '1.75.0' })

    try {
      await quietly(async () => upgradeProject(root, deps))
      expect(calls.installs.map(changes => changes.map(change => `${change.name} ${change.spec.slice(change.spec.lastIndexOf('~'))}`))).toEqual([
        ['@kaynooo/kayjs-ui ~1.73.0', 'kay ~1.73.0'],
        ['@kaynooo/kayjs-ui ~1.75.0', '@kaynooo/kayjs-mail ~1.75.0', 'kay ~1.75.0'],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists every stop on --dry-run, touching nothing', async () => {
    const root = await project(appOn('1.70.0'))
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.77.0', '@kaynooo/kayjs-ui': '1.77.0' })
    const log = spyOn(console, 'log').mockImplementation(() => undefined)

    try {
      expect(await upgradeProject(root, deps, { dryRun: true })).toBe(0)

      const printed = log.mock.calls.map(call => String(call[0])).join('\n')

      expect(printed).toContain('~1.73.0')
      expect(printed).toContain('~1.76.0')
      expect(printed).toContain('~1.77.0')
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(appOn('1.70.0'))
      expect(calls).toEqual({ installs: [], kay: [] })
    }
    finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('puts everything back when the first stop fails to install, and says so without claiming nothing is left', async () => {
    const root = await project(appOn('1.70.0'), { 'bun.lock': 'old lock\n' })
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.77.0', '@kaynooo/kayjs-ui': '1.77.0' })
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    deps.install = async (dir, changes) => {
      calls.installs.push(changes)
      await Bun.write(join(dir, 'bun.lock'), 'new lock\n')

      return false
    }

    try {
      expect(await upgradeProject(root, deps)).toBe(1)
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(appOn('1.70.0'))
      expect(await Bun.file(join(root, 'bun.lock')).text()).toBe('old lock\n')
      expect(calls.installs).toHaveLength(1)
      expect(calls.kay).toEqual([])
      expect([...log.mock.calls, ...error.mock.calls].map(call => String(call[0])).join('\n')).not.toContain('nothing left')
    }
    finally {
      log.mockRestore()
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stays at the last stop that installed when a later install fails, never saying nothing is left', async () => {
    const root = await project(appOn('1.70.0'), { 'bun.lock': 'old lock\n' })
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.77.0', '@kaynooo/kayjs-ui': '1.77.0' }, ['1.71'])
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const error = spyOn(console, 'error').mockImplementation(() => undefined)

    deps.install = async (dir, changes) => {
      calls.installs.push(changes)

      if (calls.installs.length === 1) {
        await Bun.write(join(dir, 'bun.lock'), 'stop lock\n')

        return true
      }

      await Bun.write(join(dir, 'bun.lock'), 'broken lock\n')

      return false
    }

    try {
      expect(await upgradeProject(root, deps)).toBe(1)
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(appOn('1.73.0'))
      expect(await Bun.file(join(root, 'bun.lock')).text()).toBe('stop lock\n')
      expect(calls.kay.filter(args => args[0] === 'check')).toEqual([['check', '--fix', '--since', '1.71']])

      const printed = [...log.mock.calls, ...error.mock.calls].map(call => String(call[0])).join('\n')

      expect(printed).toContain('1.76.0')
      expect(printed).not.toContain('nothing left')
    }
    finally {
      log.mockRestore()
      error.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails, never saying nothing is left, when a stop leaves a form its rewrite could not fix', async () => {
    const root = await project(appOn('1.70.0'))
    const { deps } = fakes({ '@kaynooo/kayjs': '1.77.0', '@kaynooo/kayjs-ui': '1.77.0' }, ['1.71'])
    const log = spyOn(console, 'log').mockImplementation(() => undefined)
    const kay = deps.kay

    deps.kay = async (dir, args, capture, env) => {
      const answer = await kay(dir, args, capture, env)

      return args.includes('--since') ? { ...answer, code: 1 } : answer
    }

    try {
      expect(await upgradeProject(root, deps)).toBe(1)
      expect(log.mock.calls.map(call => String(call[0])).join('\n')).not.toContain('nothing left')
    }
    finally {
      log.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a minor whose lints are still declared when it picks the stops', () => {
    const table = [{ since: '1.80' }, { since: '1.70', removedIn: '1.74' }, { since: '1.69', removedIn: '1.73' }, { since: '1.81' }]

    expect(steppingStones('1.68.0', '1.90.0', table)).toEqual(['1.72.0'])
    expect(steppingStones('1.72.0', '1.90.0', table)).toEqual([])
  })

  it('stops at the minor before the release it moves to', async () => {
    const root = await project(appOn('1.68.0'))
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.73.4', '@kaynooo/kayjs-ui': '1.73.4' })

    try {
      await quietly(async () => upgradeProject(root, deps))
      expect(calls.installs.map(changes => changes[0]!.spec)).toEqual(['~1.72.0', '~1.73.4'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('lists every minor with deprecated lints, as live or dropped, so a dropped lint cannot go without its release', async () => {
    const { version } = (await Bun.file(join(import.meta.dir, '../package.json')).json()) as { version: string }
    const current = minorOf(version)!
    const live = new Set(Object.values(LINTS).flatMap(lint => ('since' in lint ? [lint.since as string] : [])))
    const listed = new Set(DEPRECATION_MINORS.map(entry => entry.since))

    expect(listed.size).toBe(DEPRECATION_MINORS.length)
    expect([...live].filter(since => !listed.has(since))).toEqual([])
    expect(DEPRECATION_MINORS.filter(entry => entry.removedIn === undefined && !live.has(entry.since)).map(entry => entry.since)).toEqual([])
    expect(DEPRECATION_MINORS.filter(entry => entry.removedIn !== undefined && live.has(entry.since)).map(entry => entry.since)).toEqual([])

    for (const { since, removedIn } of DEPRECATION_MINORS) {
      const minor = minorOf(since)!

      if (removedIn !== undefined) {
        const removed = minorOf(removedIn)!

        expect(removed[0] === minor[0] ? removed[1] > minor[1] : removed[0] > minor[0]).toBe(true)
        expect(removed[0] < current[0] || removed[1] <= current[1]).toBe(true)
      }
    }
  })
})

describe('kay upgrade, its manifest and lockfile', () => {
  it('finds its section past a brace inside a string, and not a same-named key nested deeper', async () => {
    const manifest = `{
  "name": "app",
  "config": { "dependencies": { "kay": "npm:@kaynooo/kayjs@~1.40.1" } },
  "devDependencies": {
    "odd": "github:a/b#{x}",
    "kay": "npm:@kaynooo/kayjs@~1.40.1"
  }
}
`
    const root = await project(manifest)
    const { deps } = fakes({ '@kaynooo/kayjs': '1.46.0' })

    try {
      expect(await quietly(async () => upgradeProject(root, deps))).toBe(0)
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(manifest.replace('    "kay": "npm:@kaynooo/kayjs@~1.40.1"\n', '    "kay": "npm:@kaynooo/kayjs@~1.46.0"\n'))
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops with an error, changing nothing, when the entry it found cannot be edited in the text', async () => {
    const manifest = MANIFEST.replace('"npm:@kaynooo/kayjs@~1.40.1"', '"npm:@kaynooo/kayjs@\\u007e1.40.1"')
    const root = await project(manifest)
    const { deps, calls } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' })

    try {
      expect(await quietly(async () => upgradeProject(root, deps))).toBe(1)
      expect(await Bun.file(join(root, 'package.json')).text()).toBe(manifest)
      expect(calls).toEqual({ installs: [], kay: [] })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('puts bun.lock back with package.json when the install fails, and removes one the install made', async () => {
    const withLock = await project(MANIFEST, { 'bun.lock': 'old lock\n' })
    const withoutLock = await project()
    const failing = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' })

    failing.deps.install = async (root) => {
      await Bun.write(join(root, 'bun.lock'), 'new lock\n')

      return false
    }

    try {
      expect(await quietly(async () => upgradeProject(withLock, failing.deps))).toBe(1)
      expect(await Bun.file(join(withLock, 'bun.lock')).text()).toBe('old lock\n')
      expect(await quietly(async () => upgradeProject(withoutLock, failing.deps))).toBe(1)
      expect(await Bun.file(join(withoutLock, 'bun.lock')).exists()).toBe(false)
    }
    finally {
      await rm(withLock, { recursive: true, force: true })
      await rm(withoutLock, { recursive: true, force: true })
    }
  })
})

describe('kay upgrade through the package manager', () => {
  // A stand-in for `bun` that logs each call and answers by the script it is given.
  async function stub(answers: string): Promise<{ bun: string, calls: () => Promise<string[][]>, root: string }> {
    const root = await project()
    const log = join(root, 'calls.log')
    const bun = join(root, 'fake-bun')

    await Bun.write(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${answers}\n`)
    await chmod(bun, 0o755)

    return { bun, root, calls: async () => ((await Bun.file(log).exists()) ? (await Bun.file(log).text()).trim().split('\n').map(line => line.split(' ')) : []) }
  }

  const SPEC_UI = 'npm:@kaynooo/kayjs-ui@~1.46.0'

  it('reads the latest version from `bun info`, and gives none when it fails', async () => {
    const { bun, root, calls } = await stub('case "$2" in @kaynooo/kayjs) echo 1.46.0;; *) exit 1;; esac')

    try {
      const deps = registryDepsFor(bun)

      expect(await deps.latest('@kaynooo/kayjs', root)).toBe('1.46.0')
      expect(await deps.latest('missing', root)).toBeUndefined()
      expect(await calls()).toEqual([['info', '@kaynooo/kayjs', 'version'], ['info', 'missing', 'version']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('installs, then adds again, in its section, a package the install left at another version', async () => {
    const { bun, root, calls } = await stub('exit 0')

    try {
      const deps = registryDepsFor(bun)

      await Bun.write(join(root, 'node_modules/stale/package.json'), '{ "version": "1.40.1" }')
      await Bun.write(join(root, 'node_modules/fresh/package.json'), '{ "version": "1.46.3" }')

      expect(await deps.install(root, [
        { name: 'stale', spec: 'npm:@kaynooo/kayjs@~1.46.0', section: 'devDependencies' },
        { name: 'fresh', spec: '~1.46.0', section: 'dependencies' },
        { name: 'absent', spec: SPEC_UI, section: 'optionalDependencies' },
        { name: 'plain', spec: SPEC_UI, section: 'dependencies' },
      ])).toBe(true)
      expect(await calls()).toEqual([
        ['install'],
        ['add', '--dev', '--no-cache', 'stale@npm:@kaynooo/kayjs@~1.46.0'],
        ['add', '--optional', '--no-cache', `absent@${SPEC_UI}`],
        ['add', '--no-cache', `plain@${SPEC_UI}`],
      ])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers false when the install, or an add after it, fails', async () => {
    const failingInstall = await stub('[ "$1" = install ] && exit 1; exit 0')
    const failingAdd = await stub('[ "$1" = add ] && exit 1; exit 0')

    try {
      const change = { name: 'absent', spec: '~1.46.0', section: 'dependencies' }

      expect(await registryDepsFor(failingInstall.bun).install(failingInstall.root, [change])).toBe(false)
      expect(await failingInstall.calls()).toEqual([['install']])
      expect(await registryDepsFor(failingAdd.bun).install(failingAdd.root, [change])).toBe(false)
    }
    finally {
      await rm(failingInstall.root, { recursive: true, force: true })
      await rm(failingAdd.root, { recursive: true, force: true })
    }
  })

  it('runs the project\'s own kay through the package manager, handing back its output', async () => {
    const { bun, root, calls } = await stub('echo out')

    try {
      expect(await registryDepsFor(bun).kay(root, ['explain', 'deprecated'], true)).toEqual({ code: 0, stdout: 'out\n' })
      expect(await calls()).toEqual([[join(root, 'node_modules/kay/src/cli.ts'), 'explain', 'deprecated']])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('kay check --since', () => {
  it('takes a minor, and no group beside it', async () => {
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, CLI, 'check', ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      return { code, stderr }
    }

    expect(await run('--since', '1.46.0')).toEqual({ code: 1, stderr: 'kay check: --since takes a minor, as `1.46`, not `1.46.0`\n' })
    expect(await run('--since', '1.46', '--only', 'code')).toEqual({ code: 1, stderr: 'kay check: --since reports the deprecations of one minor, so it does not go with --only\n' })
  })
})

describe('the deprecations', () => {
  it('each name the minor that replaced the form, and come in the deprecated group alone', () => {
    const lints = Object.entries(LINTS).map(([name, lint]): { name: string, group: string, since: string | undefined } => ({ name, group: lint.group, since: (lint as { since?: string }).since }))

    expect(lints.filter(lint => (lint.group === 'deprecated') !== (lint.since !== undefined))).toEqual([])
  })

  it('keeps a deprecation three minors after the one it came in, but those listed here, which wait to go with their old form', async () => {
    const { version } = (await Bun.file(join(import.meta.dir, '../package.json')).json()) as { version: string }
    const [major, minor] = minorOf(version)!
    // Past their three minors, kept until the old form they recognise goes: when one does, its line goes from this list and its lint from LINTS.
    const overdue = new Set<string>()
    const past = Object.entries(LINTS).filter(([, lint]) => {
      const since = minorOf((lint as { since?: string }).since ?? '')

      return since !== undefined && (since[0] < major || since[1] + 3 < minor)
    }).map(([name]) => name)

    expect(past.sort()).toEqual([...overdue])
  })
})

// Migration shims kept for a few minors: the first minor each must be gone by, and the code that marks it. A shim past its minor fails here, so the release that reaches it drops it.
const SHIMS: { what: string, file: string, pattern: RegExp, removedIn: readonly [number, number] }[] = []

// Whether a shim marked for `removedIn` is overdue at `version`.
function overdue(version: string, removedIn: readonly [number, number]): boolean {
  const [major, minor] = minorOf(version)!

  return major > removedIn[0] || (major === removedIn[0] && minor >= removedIn[1])
}

describe('the migration shims', () => {
  it('judge a shim overdue from its minor on', () => {
    expect([overdue('1.73.9', [1, 74]), overdue('1.74.0', [1, 74]), overdue('2.0.0', [1, 74])]).toEqual([false, true, true])
  })

  it('are gone from the minor each names', async () => {
    const { version } = (await Bun.file(join(import.meta.dir, '../package.json')).json()) as { version: string }
    const left = await Promise.all(SHIMS.filter(shim => overdue(version, shim.removedIn)).map(async shim => (shim.pattern.test(await Bun.file(join(import.meta.dir, '..', shim.file)).text()) ? shim.what : undefined)))

    expect(left.filter(Boolean)).toEqual([])
  })
})
