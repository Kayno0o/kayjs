import { describe, expect, it } from 'bun:test'
import { APPS, overrideKay, pointAtKay, SCRIPTS, tarballName } from '../scripts/apps-ci'
import { BLOCKING, exitCode, SECRET_UNSET } from '../scripts/release-apps'

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

describe('overrideKay', () => {
  it('overrides every packed name and kay, keeping the app\'s own overrides', () => {
    const next = overrideKay({ overrides: { left: '1.0.0' } }, { '@kaynooo/kayjs': '/t/kayjs.tgz', '@kaynooo/kayjs-ui': '/t/ui.tgz' })

    expect(next.overrides).toEqual({ 'left': '1.0.0', '@kaynooo/kayjs': 'file:/t/kayjs.tgz', '@kaynooo/kayjs-ui': 'file:/t/ui.tgz', 'kay': 'file:/t/kayjs.tgz' })
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
