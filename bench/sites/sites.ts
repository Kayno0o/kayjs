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
  // What its dev servers read from the environment, none unless set: production's `env` may point a dev server elsewhere, as at the live site for its reloads.
  devEnv?: Record<string, string>
  // Runs on each side's dev copy once installed, given its directory, as for pointing the dev server's reloads back at it.
  prepareDev?: (dir: string, kind: Variant['kind']) => void | Promise<void>
  // Rewrites the Astro side's package.json before its install, as for dependencies whose pinned versions the registry lost.
  patch?: (manifest: Manifest) => void
  // Runs before the site's Astro side is exported, given the work directory, as for building a dependency it needs from source.
  prepare?: (work: string) => void | Promise<void>
  // What the dev phase edits on each side, in a copy of the site, while `page` is open; a site without it has no dev phase.
  dev?: { page: string, astro: DevEdits, kay: DevEdits }
}

// Paths relative to the site: the file and the text a template edit and a server code edit each append a word to, and the stylesheet a style edit appends a rule to.
export interface DevEdits {
  template: TextEdit
  server: TextEdit
  style: string
}

export interface TextEdit {
  file: string
  text: string
}

export interface Variant {
  site: Site
  kind: 'astro' | 'kay'
  dir: string
  // The copy the dev phase runs and edits, apart from the production build.
  devDir: string
  // Where the variant listens, then nginx in front of it over plain HTTP and over HTTP/2 with TLS, then its dev server.
  ports: { backend: number, http: number, https: number, dev: number }
}

export interface Manifest {
  dependencies: Record<string, string>
  devDependencies?: Record<string, string>
}

const EXAMPLE = join(import.meta.dir, 'sites.config.example.ts')
const CONFIG = resolve(parseArgs({ args: Bun.argv.slice(2), options: { config: { type: 'string' } }, strict: false }).values.config as string | undefined ?? process.env.SITES_CONFIG ?? join(import.meta.dir, 'sites.config.ts'))

// Outside any project: inside this repository, the sites' Tailwind and Vite would scan kay's own files, and kay's tests would scan the sites'.
export const WORK = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'kay-bench-sites')

// None without a config, which run.ts reports; the bench's tests read none.
export const SITES: Site[] = existsSync(CONFIG) ? ((await import(CONFIG)) as { default: Site[] }).default.map(site => ({ ...site, repo: resolve(dirname(CONFIG), site.repo) })) : []
export const NO_SITES = `no sites to measure: write ${CONFIG} after ${EXAMPLE}, or pass --config <file>`

// `KIND=kay` measures the kay side only, keeping the Astro figures of an earlier run; the ports stay those of a full run.
export const KIND = oneOf('KIND', ['astro', 'kay'] as const)
// `PHASE=prod` measures the production builds only, `PHASE=dev` the dev servers only, of the sites naming what to edit.
export const PHASE = oneOf('PHASE', ['prod', 'dev'] as const)
// `KAY_PACKAGE` runs the kay dev copies on another kay than the one each site pins: `checkout` for this checkout, packed, a version from the registry, or any dependency specifier (`file:`, `npm:`).
const KAY_PACKAGE = process.env.KAY_PACKAGE ?? ''
const CHECKOUT = join(import.meta.dir, '../..')
const PUBLISHED = '@kaynooo/kayjs'
// Beside a kay dev copy's install: where its kay came from.
const KAY_SOURCE = 'kay-bench-source.txt'

export const VARIANTS: Variant[] = SITES.flatMap((site, index) => (['astro', 'kay'] as const).map((kind, offset) => {
  const slot = index * 2 + offset + 1

  return { site, kind, dir: join(WORK, `${site.name}-${kind}`), devDir: join(WORK, `${site.name}-${kind}-dev`), ports: { backend: 47200 + slot, http: 47080 + slot, https: 47440 + slot, dev: 47320 + slot } }
})).filter(variant => (KIND === undefined || variant.kind === KIND) && (PHASE !== 'dev' || variant.site.dev !== undefined))

function oneOf<const Value extends string>(name: string, values: readonly Value[]): Value | undefined {
  const value = process.env[name]

  if (value === undefined || value === '')
    return undefined

  if (!values.includes(value as Value))
    throw new Error(`${name}=${value}: expected ${values.join(' or ')}`)

  return value as Value
}

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

// The dependency the kay dev copies install kay from and what the results call it, or none for the version each site pins.
function kayPackage(): { specifier: string, source: string } | undefined {
  if (KAY_PACKAGE === '')
    return undefined

  if (KAY_PACKAGE === 'checkout') {
    const commit = run(['git', 'rev-parse', '--short', 'HEAD'], CHECKOUT).trim()
    // Untracked files included, which the pack takes when its `files` cover them.
    const changed = run(['git', 'status', '--porcelain'], CHECKOUT).trim() !== ''

    run([process.execPath, 'pm', 'pack', '--filename', join(WORK, 'kay-checkout.tgz'), '--quiet'], CHECKOUT)

    return { specifier: `file:${join(WORK, 'kay-checkout.tgz')}`, source: `this checkout at ${commit}${changed ? ' with uncommitted changes' : ''}, packed` }
  }

  return KAY_PACKAGE.includes(':') ? { specifier: KAY_PACKAGE, source: KAY_PACKAGE } : { specifier: `npm:${PUBLISHED}@${KAY_PACKAGE}`, source: 'the registry' }
}

// Exports each site at its Astro commit and at its kay ref and installs them, once for the production builds, which build.ts then builds as they deploy, and once for the dev servers.
export async function prepare() {
  mkdirSync(WORK, { recursive: true })
  const kay = PHASE === 'prod' || KIND === 'astro' ? undefined : kayPackage()

  for (const variant of VARIANTS) {
    if (variant.kind === 'astro')
      await variant.site.prepare?.(WORK)

    const dirs = [...PHASE === 'dev' ? [] : [variant.dir], ...PHASE === 'prod' || variant.site.dev === undefined ? [] : [variant.devDir]]

    for (const dir of dirs) {
      exportCommit(variant.site.repo, refOf(variant), dir)

      const file = Bun.file(join(dir, 'package.json'))
      const manifest = await file.json() as Manifest
      const pinned = manifest.dependencies.kay

      if (variant.kind === 'astro')
        variant.site.patch?.(manifest)

      if (variant.kind === 'kay' && dir === variant.devDir && kay !== undefined)
        manifest.dependencies.kay = kay.specifier

      await Bun.write(file, JSON.stringify(manifest, null, 2))
      run([process.execPath, 'install'], dir)

      if (variant.kind === 'kay')
        await Bun.write(join(dir, KAY_SOURCE), dir === variant.devDir && kay !== undefined ? kay.source : `the site's own ${pinned}`)

      if (dir === variant.devDir)
        await variant.site.prepareDev?.(dir, variant.kind)
    }
  }
}

export function commitOf(variant: Variant): string {
  return run(['git', '-C', variant.site.repo, 'rev-parse', '--short', refOf(variant)], WORK).trim()
}

// The version of `name` installed in `dir`.
export async function versionIn(dir: string, name: string): Promise<string> {
  const manifest = await Bun.file(join(dir, 'node_modules', name, 'package.json')).json() as { version: string }

  return manifest.version
}

// The kay a kay copy installed, and where from.
export async function kayIn(dir: string): Promise<string> {
  const source = Bun.file(join(dir, KAY_SOURCE))

  return `kay ${await versionIn(dir, 'kay')}${await source.exists() ? `, ${await source.text()}` : ''}`
}

export function label(variant: Variant): string {
  return `${variant.site.name} ${variant.kind}`
}
