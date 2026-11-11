import type { Feature, Host } from '../src/template-shared'
import { describe, expect, it } from 'bun:test'
import { pagesWorkflow, testWorkflow } from '../src/template-ci'

function setup(host: Host) {
  return { has: (feature: Feature) => feature === 'tests', host, runner: 'alpine', tw: (classes: string) => classes, settings: {} }
}

describe('the scaffolded CI workflows', () => {
  it.each(['forgejo', 'github'] as const)('runs the %s checks once per pull request commit: a push builds main alone', (host) => {
    const on = (Bun.YAML.parse(testWorkflow(setup(host))) as { on: Record<string, unknown> }).on

    expect(on).toEqual({ push: { branches: ['main'] }, pull_request: null })
  })

  it('leaves no placeholder host as the Pages site: the forge\'s address, or the repository variable naming the Pages host', () => {
    const forgejo = pagesWorkflow(setup('forgejo'))

    expect(forgejo).not.toContain('example.com')
    expect(forgejo).toContain('SITE_URL: ${{ vars.SITE_URL || github.server_url }}')
    expect(pagesWorkflow(setup('github'))).toContain('SITE_URL: https://${{ github.repository_owner }}.github.io')
  })
})
