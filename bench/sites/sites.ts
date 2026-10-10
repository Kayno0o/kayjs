import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

export interface Site {
  // How the site is labelled in the results.
  name: string
  // Its git repository, absolute or relative to the config file.
  repo: string
  // The commit that last ran on Astro, and the ref measured on kay, HEAD unless set or `KAY_REF` names another.
  astro: string
  kay?: string
  pages: string[]
  // The pages put under load, besides the largest stylesheet the home page links; the first two pages unless set.
  loaded?: string[]
  // What the site reads from the environment when it builds and serves.
  env?: Record<string, string>
  // Rewrites the Astro side's package.json before its install, as for dependencies whose pinned versions the registry lost.
  patch?: (manifest: Manifest) => void
  // Runs before the site's Astro side is exported, given the work directory, as for building a dependency it needs from source.
  prepare?: (work: string) => void | Promise<void>
}

export interface Variant {
  site: Site
  kind: 'astro' | 'kay'
  dir: string
  // Where the variant listens, then nginx in front of it over plain HTTP and over HTTP/2 with TLS.
  ports: { backend: number, http: number, https: number }
}

export interface Manifest {
  dependencies: Record<string, string>
}

const EXAMPLE = join(import.meta.dir, 'sites.config.example.ts')
const CONFIG = resolve(parseArgs({ args: Bun.argv.slice(2), options: { config: { type: 'string' } }, strict: false }).values.config as string | undefined ?? process.env.SITES_CONFIG ?? join(import.meta.dir, 'sites.config.ts'))

// Outside any project: inside this repository, the sites' Tailwind and Vite would scan kay's own files, and kay's tests would scan the sites'.
export const WORK = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'kay-bench-sites')

if (!existsSync(CONFIG))
  throw new Error(`no sites to measure: write ${CONFIG} after ${EXAMPLE}, or pass --config <file>`)

export const SITES: Site[] = ((await import(CONFIG)) as { default: Site[] }).default.map(site => ({ ...site, repo: resolve(dirname(CONFIG), site.repo) }))

// `KIND=kay` measures the kay side only, keeping the Astro figures of an earlier run; the ports stay those of a full run.
export const KIND = process.env.KIND as Variant['kind'] | undefined

export const VARIANTS: Variant[] = SITES.flatMap((site, index) => (['astro', 'kay'] as const).map((kind, offset) => {
  const slot = index * 2 + offset + 1

  return { site, kind, dir: join(WORK, `${site.name}-${kind}`), ports: { backend: 47200 + slot, http: 47080 + slot, https: 47440 + slot } }
})).filter(variant => KIND === undefined || variant.kind === KIND)

export function run(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const output = result.stdout.toString() + result.stderr.toString()

  if (result.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed in ${cwd}:\n${output.slice(-2000)}`)

  return output
}

// Writes the repository at `ref` into `dir`, replacing what was there; a config's `prepare` may use it too.
export function exportCommit(repo: string, ref: string, dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = Bun.spawnSync(['git', '-C', repo, 'archive', ref], { stdout: 'pipe', stderr: 'pipe' })

  if (archive.exitCode !== 0)
    throw new Error(`git archive ${ref} failed in ${repo}:\n${archive.stderr.toString()}`)

  const extract = Bun.spawnSync(['tar', '-x', '-C', dir], { stdin: archive.stdout, stderr: 'pipe' })

  if (extract.exitCode !== 0)
    throw new Error(`extracting ${repo} at ${ref} failed:\n${extract.stderr.toString()}`)
}

function refOf(variant: Variant): string {
  return variant.kind === 'astro' ? variant.site.astro : process.env.KAY_REF ?? variant.site.kay ?? 'HEAD'
}

// Exports each site at its Astro commit and at its kay ref and installs them; build.ts then builds them as they deploy.
export async function prepare() {
  mkdirSync(WORK, { recursive: true })

  for (const variant of VARIANTS) {
    if (variant.kind === 'astro')
      await variant.site.prepare?.(WORK)

    exportCommit(variant.site.repo, refOf(variant), variant.dir)

    if (variant.kind === 'astro' && variant.site.patch !== undefined) {
      const file = Bun.file(join(variant.dir, 'package.json'))
      const manifest = await file.json() as Manifest

      variant.site.patch(manifest)
      await Bun.write(file, JSON.stringify(manifest, null, 2))
    }

    run(['bun', 'install'], variant.dir)
  }
}

export function commitOf(variant: Variant): string {
  return run(['git', '-C', variant.site.repo, 'rev-parse', '--short', refOf(variant)], WORK).trim()
}

export async function kayVersion(variant: Variant): Promise<string> {
  const manifest = await Bun.file(join(variant.dir, 'node_modules/kay/package.json')).json() as { version: string }

  return manifest.version
}

export function label(variant: Variant): string {
  return `${variant.site.name} ${variant.kind}`
}
