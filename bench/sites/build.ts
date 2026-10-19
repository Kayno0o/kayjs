import type { Variant } from './sites'
import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { median } from '../format'
import { tracked } from './serve'
import { BUNX, envOf, run } from './sites'

export interface BuildTime {
  command: string
  wall: number
  cpu: number
  rss: number
}

export interface Footprint {
  lines: number | undefined
  testLines: number | undefined
  // What production runs: Astro's dist, or what a side before kay ships, and its production dependencies; kay's one executable.
  deploy: number
}

const BUILDS = 3
const OUTPUTS = ['dist', '.astro', 'node_modules/.astro', 'node_modules/.vite', '.kay']

// `kay build` checks the project as `kay check` does first; `astro build` checks nothing, so kay is timed without the check too.
export function buildCommands(variant: Variant): string[][] {
  if (variant.kind === 'kay')
    return [[...BUNX, 'kay', 'build'], [...BUNX, 'kay', 'build', '--no-check']]

  return [variant.site.before?.build ?? [...BUNX, 'astro', 'build']]
}

// A command as the results show it, without the Bun running a package's bin.
export function shown(command: string[]): string {
  return (BUNX.every((part, index) => command[index] === part) ? command.slice(BUNX.length) : command).join(' ')
}

export interface CleanBuild {
  command: string[]
  cwd: string
  env?: Record<string, string>
  // Removed, relative to `cwd`, before each build, so every one is clean.
  outputs: string[]
  // The runs timed, `BUILDS` unless set.
  builds?: number
}

// Clean builds, the median of `builds`: wall seconds, CPU seconds of every process, peak memory of the largest.
export async function timeClean({ command, cwd, env = {}, outputs, builds = BUILDS }: CleanBuild): Promise<BuildTime> {
  const runs: BuildTime[] = []

  for (let build = 0; build < builds; build++) {
    for (const output of outputs)
      rmSync(join(cwd, output), { recursive: true, force: true })

    const started = performance.now()
    const proc = tracked(Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: 'ignore', stderr: 'pipe' }))
    const errors = await new Response(proc.stderr).text()

    if (await proc.exited !== 0)
      throw new Error(`${command.join(' ')} failed in ${cwd}:\n${errors}`)

    const usage = proc.resourceUsage()!

    runs.push({ command: shown(command), wall: (performance.now() - started) / 1000, cpu: Number(usage.cpuTime.total) / 1e6, rss: usage.maxRSS })
  }

  return { command: runs[0]!.command, wall: median(runs.map(r => r.wall)), cpu: median(runs.map(r => r.cpu)), rss: median(runs.map(r => r.rss)) }
}

export async function timeBuild(variant: Variant, command: string[]): Promise<BuildTime> {
  const time = await timeClean({ command, cwd: variant.dir, env: envOf(variant), outputs: variant.site.before?.outputs ?? OUTPUTS })

  // The servers run what the last build left, the executable included.
  if (variant.kind === 'kay')
    run([...BUNX, 'kay', 'build', '--compile', 'server'], variant.dir, envOf(variant))

  return time
}

// Lines of code by cloc when it is installed, `.kay` and `.astro` read as Vue's single-file components.
function cloc(paths: string[]): number | undefined {
  if (Bun.which('cloc') === null || paths.length === 0)
    return undefined

  const csv = run(['cloc', '--quiet', '--csv', '--force-lang=Vuejs Component,kay', '--force-lang=Vuejs Component,astro', '--exclude-dir=baseline', ...paths], '/')

  return Number(csv.trim().split('\n').at(-1)!.split(',')[4])
}

function size(path: string): number {
  return Number.parseInt(run(['du', '-sb', path], '/'), 10)
}

export function footprint(variant: Variant): Footprint {
  const configs = [...new Bun.Glob('{*.config.*,solid.config.ts}').scanSync({ cwd: variant.dir, absolute: true })]
  const tests = join(variant.dir, 'tests')

  if (variant.kind === 'kay')
    return { lines: cloc([join(variant.dir, 'src'), ...configs]), testLines: existsSync(tests) ? cloc([tests]) : 0, deploy: statSync(join(variant.dir, 'server')).size }

  const before = variant.site.before
  const sources = (before?.sources ?? ['src']).map(path => join(variant.dir, path)).filter(path => existsSync(path))
  const shipped = before?.deploy ?? before?.outputs ?? ['dist']
  const prod = `${variant.dir}-prod`

  rmSync(prod, { recursive: true, force: true })
  cpSync(variant.dir, prod, { recursive: true, filter: source => !source.slice(variant.dir.length).includes('/node_modules') })
  run([process.execPath, 'install', '--production', '--ignore-scripts'], prod)

  // A side without production dependencies installs no node_modules.
  const modules = join(prod, 'node_modules')

  return { lines: cloc([...sources, ...configs]), testLines: before !== undefined && existsSync(tests) ? cloc([tests]) : 0, deploy: (existsSync(modules) ? size(modules) : 0) + shipped.map(path => join(variant.dir, path)).filter(path => existsSync(path)).reduce((sum, path) => sum + size(path), 0) }
}
