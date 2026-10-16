import type { DependencyChange, UpgradeDeps } from '../src/commands/upgrade'
import { chmod, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test'
import { registryDepsFor, upgradeProject } from '../src/commands/upgrade'
import { LINTS, minorOf } from '../src/compiler/lints'
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
        ['check', '--fix'],
      ])
    }
    finally {
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

  it('rewrites the old forms with the project\'s own kay, a minor at a time, across the kay it moved from', async () => {
    const root = await project(MANIFEST.replace('~1.40.1', '~1.20.0'), {
      'tsconfig.json': await Bun.file(join(import.meta.dir, '../tsconfig.json')).text(),
      'src/routes/index.kay': 'p Home\n',
      'src/refresh.ts': 'import { invalidatePage } from \'kay/server\'\n\nexport const refresh = () => invalidatePage(\'/\')\n',
    })
    const run = (args: string[], capture: boolean) => Bun.spawn([process.execPath, CLI, ...args], { cwd: root, stdout: capture ? 'pipe' : 'ignore', stderr: 'ignore' })
    const { deps } = fakes({ '@kaynooo/kayjs': '1.46.0', '@kaynooo/kayjs-ui': '1.46.0' })

    deps.kay = async (_root, args, capture) => {
      const child = run(args, capture)
      const [stdout, code] = await Promise.all([capture ? new Response(child.stdout).text() : '', child.exited])

      return { code, stdout }
    }

    try {
      await quietly(async () => upgradeProject(root, deps))
      expect(await Bun.file(join(root, 'src/refresh.ts')).text()).toBe('import { invalidatePage } from \'kay/cache\'\n\nexport const refresh = () => invalidatePage(\'/\')\n')
    }
    finally {
      await rm(root, { recursive: true, force: true })
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
      await Bun.write(join(root, 'node_modules/fresh/package.json'), '{ "version": "1.46.0" }')

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
  it('fixes the deprecations of its minor alone', async () => {
    const root = await project(MANIFEST, {
      'tsconfig.json': await Bun.file(join(import.meta.dir, '../tsconfig.json')).text(),
      'src/routes/index.kay': 'p Home\n',
      'src/refresh.ts': 'import { invalidatePage } from \'kay/server\'\n\nexport const refresh = () => invalidatePage(\'/\')\n',
    })
    const run = async (since: string) => Bun.spawn([process.execPath, CLI, 'check', '--fix', '--since', since], { cwd: root, stdout: 'ignore', stderr: 'ignore' }).exited

    try {
      await run('1.47')
      expect(await Bun.file(join(root, 'src/refresh.ts')).text()).toContain('kay/server')
      await run('1.46')
      expect(await Bun.file(join(root, 'src/refresh.ts')).text()).toContain('kay/cache')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

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
    const lints = Object.entries(LINTS).map(([name, lint]) => ({ name, group: lint.group, since: 'since' in lint ? lint.since : undefined }))

    expect(lints.filter(lint => (lint.group === 'deprecated') !== (lint.since !== undefined))).toEqual([])
  })

  it('keeps a deprecation three minors after the one it came in, but those listed here, which wait to go with their old form', async () => {
    const { version } = (await Bun.file(join(import.meta.dir, '../package.json')).json()) as { version: string }
    const [major, minor] = minorOf(version)!
    // Past their three minors, kept until the old form they recognise goes: when one does, its line goes from this list and its lint from LINTS.
    const overdue = new Set<string>()
    const past = Object.entries(LINTS).filter(([, lint]) => 'since' in lint && lint.since !== undefined && (minorOf(lint.since)![0] < major || minorOf(lint.since)![1] + 3 < minor)).map(([name]) => name)

    expect(past.sort()).toEqual([...overdue])
  })
})
