import { chmod } from 'node:fs/promises'
import { describe, expect, it } from 'bun:test'
import { APPS, cleanClones, clones, overrideKay, pointApp, pointAtKay, SCRIPTS, tarballName, workspaceDirs, writeStubs } from '../scripts/apps-ci'
import { BLOCKING, dispatchRun, exitCode, NO_FT, SECRET_UNSET } from '../scripts/release-apps'
import { scratchDir } from './scratch'

interface Step {
  name?: string
  run?: string
  env?: Record<string, string>
}

const workflow = Bun.YAML.parse(await Bun.file('.forgejo/workflows/apps.yml').text()) as { on: Record<string, unknown>, jobs: { apps: { steps: Step[] } } }
const steps = workflow.jobs.apps.steps

describe('pointAtKay', () => {
  const tarballs = { '@kaynooo/kayjs': '/t/kayjs.tgz', '@kaynooo/kayjs-ui': '/t/ui.tgz' }

  it('points kay under its alias and each library at their tarballs, leaving the rest', () => {
    const next = pointAtKay({
      dependencies: { 'kay': 'npm:@kaynooo/kayjs@~1.77.0', '@kaynooo/kayjs-ui': '~1.77.0', 'elysia': '^1.4.0' },
      devDependencies: { '@kaynooo/kayjs-mail': '~1.77.0' },
    }, tarballs)

    expect(next?.dependencies).toEqual({ 'kay': 'file:/t/kayjs.tgz', '@kaynooo/kayjs-ui': 'file:/t/ui.tgz', 'elysia': '^1.4.0' })
    expect(next?.devDependencies).toEqual({ '@kaynooo/kayjs-mail': '~1.77.0' })
  })

  it('returns undefined for a manifest that depends on neither', () => {
    expect(pointAtKay({ dependencies: { elysia: '^1.4.0' } }, tarballs)).toBeUndefined()
    expect(pointAtKay({}, tarballs)).toBeUndefined()
  })
})

describe('tarballName', () => {
  it('follows bun pm pack', () => {
    expect(tarballName('@kaynooo/kayjs-ui', '1.83.0')).toBe('kaynooo-kayjs-ui-1.83.0.tgz')
  })
})

describe('Apps workflow', () => {
  it('runs on demand only, never on a push', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  })

  it('has one step per app, each handing it the token', () => {
    const appSteps = steps.filter(step => step.run?.startsWith('bun scripts/apps-ci.ts ') && !step.run.endsWith(' pack'))

    expect(appSteps.map(step => step.run)).toEqual(APPS.map(app => `bun scripts/apps-ci.ts ${app.name}`))
    expect(appSteps.map(step => step.name)).toEqual(APPS.map(app => app.name))

    for (const step of appSteps)
      expect(step.env?.KAY_APPS_TOKEN).toBe('${{ secrets.KAY_APPS_TOKEN }}')
  })

  it('fails first, naming the secret, when it is not set', () => {
    expect(steps[0]?.run).toContain('KAY_APPS_TOKEN')
  })
})

describe('APPS', () => {
  it('names each app once, with skips only of scripts it runs', () => {
    expect(new Set(APPS.map(app => app.name)).size).toBe(APPS.length)

    for (const app of APPS) {
      for (const script of Object.keys(app.skip ?? {}))
        expect(SCRIPTS as readonly string[]).toContain(script)
    }
  })
})

describe('workspaceDirs', () => {
  async function workspace(workspaces: unknown, packages: Record<string, Record<string, string> | undefined>) {
    const dir = await scratchDir('workspaces')

    await Bun.write(`${dir}/package.json`, JSON.stringify({ workspaces }))

    for (const [path, scripts] of Object.entries(packages))
      await Bun.write(`${dir}/${path}/package.json`, JSON.stringify(scripts === undefined ? {} : { scripts }))

    return dir
  }

  it('lists each workspace with a check, lint or test script, nested ones and patterns included, in order', async () => {
    const dir = await workspace(['shell', 'shell/tests/fixture', 'libs/*', 'docs', 'missing'], {
      'shell': { check: 'kay check' },
      'shell/tests/fixture': { lint: 'keslint' },
      'libs/a': { test: 'bun test' },
      'libs/b': { build: 'kay build' },
      'docs': undefined,
    })

    expect(await workspaceDirs(dir)).toEqual(['shell', 'shell/tests/fixture', 'libs/a'])
  })

  it('reads the packages of the object form, and none from a manifest without workspaces', async () => {
    expect(await workspaceDirs(await workspace({ packages: ['a'] }, { a: { test: 'bun test' } }))).toEqual(['a'])
    expect(await workspaceDirs(await workspace(undefined, {}))).toEqual([])
  })

  it('drops a ./ prefix and leaves out what a !pattern matches', async () => {
    const dir = await workspace(['./a', 'libs/*', '!libs/b', '!./c'], {
      'a': { test: 'bun test' },
      'libs/b': { test: 'bun test' },
      'libs/d': { test: 'bun test' },
      'c': { test: 'bun test' },
    })

    expect(await workspaceDirs(dir)).toEqual(['a', 'libs/d'])
  })

  it('is how orbit runs every workspace, not a list kept beside it', () => {
    expect(APPS.find(app => app.name === 'orbit')?.dirs).toBe('workspaces')
  })
})

describe('writeStubs', () => {
  it('writes the files the clone lacks and never blanks one it holds', async () => {
    const dir = await scratchDir('stubs')

    await Bun.write(`${dir}/kept.env`, 'SECRET=1')
    await writeStubs(dir, ['kept.env', 'deep/new.env'])

    expect(await Bun.file(`${dir}/kept.env`).text()).toBe('SECRET=1')
    expect(await Bun.file(`${dir}/deep/new.env`).text()).toBe('')
  })
})

describe('the clones directory', () => {
  it('is removed by cleanClones, and left alone when KAY_APPS_CLONES names it', async () => {
    const tmp = await scratchDir('clones-tmp')
    const previous = process.env.TMPDIR

    process.env.TMPDIR = tmp

    try {
      const dir = await clones()

      expect(dir.startsWith(`${tmp}/kay-apps-ci-`)).toBe(true)
      expect(await clones()).toBe(dir)
      await cleanClones()
      expect(new Bun.Glob('kay-apps-ci-*').scanSync({ cwd: tmp, onlyFiles: false }).next().done).toBe(true)
    }
    finally {
      if (previous === undefined)
        delete process.env.TMPDIR
      else
        process.env.TMPDIR = previous
    }
  })

  it('leaves nothing in the temp dir after a run that ends on an error', async () => {
    const tmp = await scratchDir('clones-run')
    const run = Bun.spawn(['bun', 'scripts/apps-ci.ts', 'no-such-app'], { env: { ...process.env, TMPDIR: tmp }, stdout: 'ignore', stderr: 'ignore' })

    expect(await run.exited).not.toBe(0)
    expect(Array.from(new Bun.Glob('kay-apps-ci-*').scanSync({ cwd: tmp, onlyFiles: false }))).toEqual([])
  })
})

describe('overrideKay', () => {
  it('overrides every packed name and kay, keeping the app\'s own overrides', () => {
    const next = overrideKay({ overrides: { left: '1.0.0' } }, { '@kaynooo/kayjs': '/t/kayjs.tgz', '@kaynooo/kayjs-ui': '/t/ui.tgz' })

    expect(next.overrides).toEqual({ 'left': '1.0.0', '@kaynooo/kayjs': 'file:/t/kayjs.tgz', '@kaynooo/kayjs-ui': 'file:/t/ui.tgz', 'kay': 'file:/t/kayjs.tgz' })
  })
})

describe('pointApp', () => {
  const tarballs = { '@kaynooo/kayjs': '/t/kayjs.tgz', '@kaynooo/kayjs-ui': '/t/ui.tgz' }

  it('overrides at a workspace root that has no kay dependency of its own', () => {
    const next = pointApp({
      'package.json': { workspaces: ['shell', 'relay'] },
      'shell/package.json': { dependencies: { kay: 'npm:@kaynooo/kayjs@~1.77.0' } },
      'relay/package.json': { dependencies: { elysia: '^1.4.0' } },
    }, 'package.json', tarballs)

    expect(Object.keys(next).sort()).toEqual(['package.json', 'shell/package.json'])
    expect(next['package.json']).toEqual({ workspaces: ['shell', 'relay'], devDependencies: { 'axe-core': '^4.14.0', 'typescript7': 'npm:typescript@^7.0.2' }, overrides: { '@kaynooo/kayjs': 'file:/t/kayjs.tgz', '@kaynooo/kayjs-ui': 'file:/t/ui.tgz', 'kay': 'file:/t/kayjs.tgz' } })
  })

  it('overrides at a root that depends on kay itself, and only for the install folder', () => {
    const next = pointApp({
      'dashboard/package.json': { dependencies: { '@kaynooo/kayjs-ui': '~1.77.0' } },
      'other/package.json': { dependencies: { '@kaynooo/kayjs-ui': '~1.77.0' } },
    }, 'dashboard/package.json', tarballs)

    expect(next['dashboard/package.json']?.overrides).toBeDefined()
    expect(next['other/package.json']?.overrides).toBeUndefined()
  })

  it('changes nothing when no manifest names kay', () => {
    expect(pointApp({ 'package.json': { workspaces: ['a'] }, 'a/package.json': {} }, 'package.json', tarballs)).toEqual({})
  })
})

describe('release wait', () => {
  it('lets a red run go through until the apps block a release, and stops it after', () => {
    expect(exitCode('success', false)).toBe(0)
    expect(exitCode('failure', false)).toBe(0)
    expect(exitCode('success', true)).toBe(0)
    expect(exitCode('failure', true)).toBe(1)
  })

  it('names the secret the workflow reports when it is unset', async () => {
    const workflow = await Bun.file('.forgejo/workflows/apps.yml').text()

    expect(workflow).toContain(SECRET_UNSET)
    expect(typeof BLOCKING).toBe('boolean')
  })
})

describe('the Apps workflow dispatch', () => {
  // A PATH holding a stub ft that records its argv, then prints `out` on stdout or `err` on stderr.
  async function stub(script: { out?: string, err?: string, exit?: number }) {
    const dir = await scratchDir('dispatch')

    await Bun.write(`${dir}/ft`, `#!/bin/sh\necho "ft $*" >> "${dir}/calls"\nprintf '%s' '${script.out ?? ''}'\nprintf '%s' '${script.err ?? ''}' >&2\nexit ${script.exit ?? 0}\n`)
    await chmod(`${dir}/ft`, 0o755)

    return dir
  }

  it('starts the run on the sha through ft and answers its id', async () => {
    const dir = await stub({ out: '{"id":6597,"number":1196,"workflow":"apps.yml","ref":"abc123","url":"https://forge/runs/1196"}' })

    expect(await dispatchRun('apps.yml', 'abc123', { path: dir })).toEqual({ id: 6597 })
    expect(await Bun.file(`${dir}/calls`).text()).toBe('ft dispatch apps.yml --ref abc123 --json\n')
  })

  it('answers ft\'s own words when it refuses, out of its JSON', async () => {
    const json = await stub({ err: '{"error":"workflow \\"apps.yml\\" is not found","hint":"ft runs lists them"}', exit: 1 })
    const plain = await stub({ err: 'tea: not logged in', exit: 1 })
    const silent = await stub({ exit: 2 })

    expect(await dispatchRun('apps.yml', 'abc123', { path: json })).toEqual({ error: 'workflow "apps.yml" is not found (ft runs lists them)' })
    expect(await dispatchRun('apps.yml', 'abc123', { path: plain })).toEqual({ error: 'tea: not logged in' })
    expect(await dispatchRun('apps.yml', 'abc123', { path: silent })).toEqual({ error: 'exit 2' })
  })

  it('answers an error, not a throw, when ft prints no run id', async () => {
    const text = await stub({ out: 'Started apps.yml on main' })

    expect(await dispatchRun('apps.yml', 'abc123', { path: text })).toEqual({ error: 'ft dispatch answered no run id: Started apps.yml on main' })
  })

  it('fails clearly without ft', async () => {
    expect(await dispatchRun('apps.yml', 'abc123', { path: await scratchDir('no-ft') })).toEqual({ error: NO_FT })
  })
})
