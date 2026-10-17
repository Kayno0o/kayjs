import type { AppName } from './apps'
import type { BuildTime } from './sites/build'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { timeClean } from './sites/build'

export interface BuildResult {
  wall: number
  // What the build deploys, bytes.
  raw: number
  gzip: number
  files: number
}

interface Build {
  command: string[]
  // Removed before each build, relative to the app: its output and the caches its tool keeps.
  clean: string[]
  // Where the deployed output is, relative to the app.
  counted: string[]
  // Files under `counted` that are tooling's, not deployed, as paths relative to the app.
  ignored?: RegExp
}

export interface BuildLabel {
  name: string
  app: AppName
  build: Build
}

const ROOT = join(import.meta.dir, '..')
const DIR = join(import.meta.dir, 'apps')
const BUN = process.execPath
// Source maps and precompressed copies are not what a build is judged by: kay writes `.br` and `.gz` beside every file, and a map is for debugging.
const NOT_DEPLOYED = /\.(?:map|br|gz|zst)$/
const TELEMETRY = { NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1', ASTRO_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' }

// Each app's clean production build the way its framework runs it. kay is timed as `kay build` runs it, `kay check` included, and with `--no-check`, as `astro build` checks nothing; Next's build type-checks as it goes.
export const BUILDS: BuildLabel[] = [
  { name: 'kay', app: 'kay', build: { command: [BUN, join(ROOT, 'src/cli.ts'), 'build', '--quiet'], clean: ['.kay'], counted: ['.kay/client/dist', '.kay/client/pages'] } },
  { name: 'kay --no-check', app: 'kay', build: { command: [BUN, join(ROOT, 'src/cli.ts'), 'build', '--quiet', '--no-check'], clean: ['.kay'], counted: ['.kay/client/dist', '.kay/client/pages'] } },
  { name: 'solid', app: 'solid', build: { command: [BUN, 'build.ts'], clean: ['dist'], counted: ['dist'] } },
  { name: 'svelte', app: 'svelte', build: { command: [BUN, 'build.ts'], clean: ['dist'], counted: ['dist'] } },
  { name: 'astro', app: 'astro', build: { command: [BUN, join('node_modules', 'astro', 'bin', 'astro.mjs'), 'build'], clean: ['dist', '.astro', 'node_modules/.astro', 'node_modules/.vite'], counted: ['dist'] } },
  { name: 'next', app: 'next', build: { command: [BUN, join('node_modules', 'next', 'dist', 'bin', 'next'), 'build'], clean: ['.next'], counted: ['.next'], ignored: /^\.next\/(?:cache|diagnostics|types|trace)/ } },
  { name: 'nuxt', app: 'nuxt', build: { command: [BUN, join('node_modules', 'nuxt', 'bin', 'nuxt.mjs'), 'build'], clean: ['.nuxt', '.output', 'node_modules/.cache', 'node_modules/.vite'], counted: ['.output'] } },
]

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

// Every file the build deployed, raw and as gzip sends it.
export function weighOutput(appDir: string, counted: string[], ignored?: RegExp): Omit<BuildResult, 'wall'> {
  let raw = 0
  let gzip = 0
  let count = 0

  for (const path of counted.flatMap(dir => files(join(appDir, dir)))) {
    if (NOT_DEPLOYED.test(path) || ignored?.test(relative(appDir, path)))
      continue

    const body = readFileSync(path)

    raw += statSync(path).size
    gzip += Bun.gzipSync(body).length
    count++
  }

  return { raw, gzip, files: count }
}

// Clean builds of every app, one after the other and before anything else is timed: `runs` of each, the wall time their median, the size that of the last, which does not vary.
export async function buildAll(runs: number, onBuild: (name: string) => void): Promise<BuildResult[]> {
  const results: BuildResult[] = []

  for (const { name, app, build } of BUILDS) {
    const cwd = join(DIR, app)

    onBuild(name)

    const time: BuildTime = await timeClean({ command: build.command, cwd, env: TELEMETRY, outputs: build.clean, builds: runs })

    results.push({ wall: time.wall, ...weighOutput(cwd, build.counted, build.ignored) })
  }

  return results
}
