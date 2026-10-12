import { Glob } from 'bun'
import { describe, expect, it } from 'bun:test'

interface Manifest {
  name: string
  version: string
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
    const ranges = Object.entries({ ...manifest.peerDependencies, ...manifest.devDependencies }).filter(([name]) => names.has(name))

    expect(ranges.filter(([, range]) => range !== 'workspace:~')).toEqual([])
  })
})
