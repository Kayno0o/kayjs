import { dirname, join, normalize } from 'node:path'
import { expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
// A value import, static or dynamic; a type import ships nothing.
const VALUE_IMPORT = /^import (?!type )[^'\n]*'([^']+)'|\bimport\('([^']+)'\)/gm
const OPTIONAL = ['chartist', 'hls.js']

const sources = new Map<string, string>()

for (const path of await Array.fromAsync(new Bun.Glob('src/**/*.{kay,ts}').scan({ cwd: ROOT })))
  sources.set(path, await Bun.file(join(ROOT, path)).text())

// The optional peers a module reaches through its own value imports and theirs: a bundler resolves every one, even a dynamic import nothing calls, so a component reaching a peer fails the app's build without it.
function peersOf(path: string, seen = new Set<string>()): string[] {
  if (seen.has(path))
    return []

  seen.add(path)

  return [...sources.get(path)!.matchAll(VALUE_IMPORT)].flatMap(([, specifier = '', dynamic = '']) => {
    const target = specifier || dynamic

    if (OPTIONAL.includes(target))
      return [target]

    if (!target.startsWith('.'))
      return []

    const resolved = normalize(join(dirname(path), target))
    const file = [resolved, `${resolved}.ts`].find(candidate => sources.has(candidate))

    return file ? peersOf(file, seen) : []
  })
}

test('only LineChart reaches chartist and only MediaGallery hls.js, so no other component needs an optional peer installed', () => {
  const reaching = [...sources.keys()].filter(path => path.endsWith('.kay')).flatMap(path => [...new Set(peersOf(path))].map(peer => `${path} ${peer}`))

  expect(reaching.sort()).toEqual(['src/line-chart.kay chartist', 'src/media-gallery.kay hls.js'])
})
