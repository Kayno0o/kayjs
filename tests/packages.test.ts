import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { stampUnreleased, WHATS_NEW } from '../scripts/whats-new'

interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const root = await Bun.file('package.json').json() as Manifest
const libraries = await Promise.all((await Array.fromAsync(new Glob('packages/*/package.json').scan())).sort().map(async path => ({ path, manifest: await Bun.file(path).json() as Manifest })))
const names = new Set(libraries.map(({ manifest }) => manifest.name))
const [major, minor] = root.version.split('.')

// scripts/version.ts moves kay and its libraries together: a library a version apart, or naming another by a range, would publish the drift the monorepo exists to prevent.
describe('kay\'s libraries', () => {
  it.each(libraries)('$path is at kay\'s version and peers on kay\'s minor', ({ manifest }) => {
    expect(manifest.version).toBe(root.version)
    expect(manifest.peerDependencies?.kay).toBe(`~${major}.${minor}.0`)
  })

  it.each(libraries)('$path names the other libraries as workspaces', ({ manifest }) => {
    const ranges = [manifest.dependencies, manifest.optionalDependencies, manifest.peerDependencies, manifest.devDependencies].flatMap(field => Object.entries(field ?? {})).filter(([name]) => names.has(name))

    expect(ranges.filter(([, range]) => range !== 'workspace:~')).toEqual([])
  })
})

// scripts/version.ts names What's new's pending section after the release, where the release notes read it.
describe('what\'s new', () => {
  it('names the Unreleased section after the version, and leaves a page without one as it is', () => {
    expect(stampUnreleased('# What\'s new\n\n## Unreleased\n\n- a\n\n## 1.43.0\n\n- b\n', '1.44.0')).toBe('# What\'s new\n\n## 1.44.0\n\n- a\n\n## 1.43.0\n\n- b\n')
    expect(stampUnreleased('# What\'s new\n\nNothing is ## Unreleased here.\n\n### Unreleased\n\n## 1.43.0\n', '1.44.0')).toBe('# What\'s new\n\nNothing is ## Unreleased here.\n\n### Unreleased\n\n## 1.43.0\n')
  })

  it('gives the docs page and the llms page the same releases in the same order', async () => {
    const sections = await Promise.all(WHATS_NEW.map(async path => [...(await Bun.file(path).text()).matchAll(/^## (.+)$/gm)].map(match => match[1])))

    expect(sections[0]!.length).toBeGreaterThan(0)
    expect(sections[1]).toEqual(sections[0])
  })
})
