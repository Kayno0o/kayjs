import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'
import { archiveOldest, stampUnreleased } from '../scripts/whats-new'

interface Manifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: { bun?: string }
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

  // One install serves the whole workspace: a tool kay and a library both develop with, at two ranges, would have one of them test against a version it does not name.
  it('develop with the ranges kay and the other libraries name for the same dependency', () => {
    const ranges = new Map<string, Set<string>>()

    for (const field of [root.dependencies, root.devDependencies, ...libraries.map(({ manifest }) => manifest.devDependencies)]) {
      for (const [name, range] of Object.entries(field ?? {}).filter(([name]) => !names.has(name)))
        ranges.set(name, (ranges.get(name) ?? new Set()).add(range))
    }

    expect([...ranges].filter(([, named]) => named.size > 1).map(([name, named]) => [name, [...named]])).toEqual([])
  })

  it.each(libraries)('$path asks for the Bun kay asks for', ({ manifest }) => {
    expect(manifest.engines?.bun).toBe(root.engines!.bun)
  })
})

// scripts/version.ts names What's new's pending section after the release, where the release notes read it.
describe('what\'s new', () => {
  it('names the Unreleased section after the version, and leaves a page without one as it is', () => {
    expect(stampUnreleased('# What\'s new\n\n## Unreleased\n\n- a\n\n## 1.43.0\n\n- b\n', '1.44.0')).toBe('# What\'s new\n\n## 1.44.0\n\n- a\n\n## 1.43.0\n\n- b\n')
    expect(stampUnreleased('# What\'s new\n\nNothing is ## Unreleased here.\n\n### Unreleased\n\n## 1.43.0\n', '1.44.0')).toBe('# What\'s new\n\nNothing is ## Unreleased here.\n\n### Unreleased\n\n## 1.43.0\n')
  })

  it('moves the oldest releases to the archive while the page is over its limit, and the "before" version with them', () => {
    const page = '# New\n\nIntro.\n\n## 1.46.0\n\n- c\n\n## 1.45.0\n\n- bb\n\n## 1.44.0\n\n- aaaaaaaaaa\n\nReleases before 1.44 are in [Old](old.md).\n'
    const archive = '# Old\n\nWhat each release before 1.44 added.\n\n## 1.43.0\n\n- z\n'

    expect(archiveOldest(page, archive, 1000)).toEqual({ page, archive })
    expect(archiveOldest(page, archive, 100)).toEqual({
      page: '# New\n\nIntro.\n\n## 1.46.0\n\n- c\n\n## 1.45.0\n\n- bb\n\nReleases before 1.45 are in [Old](old.md).\n',
      archive: '# Old\n\nWhat each release before 1.45 added.\n\n## 1.44.0\n\n- aaaaaaaaaa\n\n## 1.43.0\n\n- z\n',
    })
    // The newest release stays whatever the limit, and a page without the "before" line is left as it is.
    expect(archiveOldest(page, archive, 1).page).toContain('## 1.46.0')
    expect(archiveOldest(page, archive, 1).page).not.toContain('## 1.45.0')
    expect(archiveOldest(page.replace(/Releases before.*\n/, ''), archive, 1)).toEqual({ page: page.replace(/Releases before.*\n/, ''), archive })
  })
})
