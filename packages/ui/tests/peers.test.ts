import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..')
// A static value import; a type import ships nothing, and a dynamic one is checked by building it below.
const STATIC_IMPORT = /^import (?!type )[^'\n]*'([^']+)'/gm
const OPTIONAL = ['chartist', 'hls.js']

const sources = new Map<string, string>()

for (const path of await Array.fromAsync(new Bun.Glob('src/**/*.{kay,ts}').scan({ cwd: ROOT })))
  sources.set(path, await Bun.file(join(ROOT, path)).text())

// The optional peers a module reaches through its own static imports and theirs: a bundler fails on any it cannot resolve, so a component reaching one needs it installed.
function peersOf(path: string, seen = new Set<string>()): string[] {
  if (seen.has(path))
    return []

  seen.add(path)

  return [...sources.get(path)!.matchAll(STATIC_IMPORT)].flatMap(([, target = '']) => {
    if (OPTIONAL.includes(target))
      return [target]

    if (!target.startsWith('.'))
      return []

    const resolved = normalize(join(dirname(path), target))
    const file = [resolved, `${resolved}.ts`].find(candidate => sources.has(candidate))

    return file ? peersOf(file, seen) : []
  })
}

test('only LineChart needs an optional peer installed, chartist', () => {
  const reaching = [...sources.keys()].filter(path => path.endsWith('.kay')).flatMap(path => [...new Set(peersOf(path))].map(peer => `${path} ${peer}`))

  expect(reaching).toEqual(['src/line-chart.kay chartist'])
})

test('MediaGallery\'s player builds without hls.js installed, and says to install it once a playlist needs it', async () => {
  // Outside the repository, where nothing resolves hls.js.
  const dir = await mkdtemp(join(tmpdir(), 'kayjs-ui-peers-'))
  const errors: string[] = []
  const { error } = console

  try {
    await Bun.write(join(dir, 'media.ts'), sources.get('src/media.ts')!)

    const build = await Bun.build({ entrypoints: [join(dir, 'media.ts')], outdir: join(dir, 'out'), target: 'browser' })

    expect(build.success).toBe(true)

    const { playSource } = await import(join(dir, 'out', 'media.js')) as typeof import('../src/media')
    const video = { src: '', canPlayType: () => '', addEventListener: () => undefined } as unknown as HTMLVideoElement

    console.error = (...args: unknown[]) => void errors.push(args.join(' '))
    playSource(video, '/live.m3u8')
    await Bun.sleep(50)

    expect([video.src, errors]).toEqual(['/live.m3u8', [expect.stringContaining('bun add hls.js')]])
  }
  finally {
    console.error = error
    await rm(dir, { recursive: true, force: true })
  }
})
