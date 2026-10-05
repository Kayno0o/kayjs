import type { Variant } from './sites'
import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { median } from '../format'
import { run } from './sites'

export interface BuildTime {
  command: string
  wall: number
  cpu: number
  rss: number
}

export interface Footprint {
  lines: number | undefined
  testLines: number | undefined
  // What production runs: Astro's dist and production dependencies, kay's one executable.
  deploy: number
}

const BUILDS = 3
const OUTPUTS = ['dist', '.astro', 'node_modules/.astro', 'node_modules/.vite', '.kay']

// `kay build` checks the project as `kay check` does first; `astro build` checks nothing, so kay is timed without the check too.
export function buildCommands(variant: Variant): string[][] {
  return variant.kind === 'astro' ? [['bunx', '--bun', 'astro', 'build']] : [['bunx', 'kay', 'build'], ['bunx', 'kay', 'build', '--no-check']]
}

// Clean builds, medians of `BUILDS`: wall seconds, CPU seconds of every process, peak memory of the largest.
export async function timeBuild(variant: Variant, command: string[]): Promise<BuildTime> {
  const runs: BuildTime[] = []

  for (let build = 0; build < BUILDS; build++) {
    for (const output of OUTPUTS)
      rmSync(join(variant.dir, output), { recursive: true, force: true })

    const started = performance.now()
    const proc = Bun.spawn(command, { cwd: variant.dir, env: { ...process.env, ...variant.site.env }, stdout: 'ignore', stderr: 'pipe' })
    const errors = await new Response(proc.stderr).text()

    if (await proc.exited !== 0)
      throw new Error(`${command.join(' ')} failed in ${variant.dir}:\n${errors}`)

    const usage = proc.resourceUsage()!

    runs.push({ command: command.filter(word => word !== 'bunx' && word !== '--bun').join(' '), wall: (performance.now() - started) / 1000, cpu: Number(usage.cpuTime.total) / 1e6, rss: usage.maxRSS })
  }

  // The servers run what the last build left, the executable included.
  if (variant.kind === 'kay')
    run(['bunx', 'kay', 'build', '--compile', 'server'], variant.dir)

  return { command: runs[0]!.command, wall: median(runs.map(r => r.wall)), cpu: median(runs.map(r => r.cpu)), rss: median(runs.map(r => r.rss)) }
}

// Lines of code by cloc when it is installed, `.kay` and `.astro` read as Vue's single-file components.
function cloc(paths: string[]): number | undefined {
  if (!Bun.which('cloc') || paths.length === 0)
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

  const prod = `${variant.dir}-prod`

  rmSync(prod, { recursive: true, force: true })
  cpSync(variant.dir, prod, { recursive: true, filter: source => !source.slice(variant.dir.length).includes('/node_modules') })
  run(['bun', 'install', '--production', '--ignore-scripts'], prod)

  return { lines: cloc([join(variant.dir, 'src'), ...configs]), testLines: 0, deploy: size(join(prod, 'node_modules')) + size(join(variant.dir, 'dist')) }
}
