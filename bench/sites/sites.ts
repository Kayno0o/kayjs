import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface Site {
  name: 'cromignon24' | 'jb-peinture'
  // The commit that last ran on Astro; kay is measured at HEAD unless `KAY_REF` names another.
  astro: string
  pages: string[]
  // What the site reads from the environment when it builds and serves.
  env: Record<string, string>
  // Swaps the Astro site's dependencies whose pinned versions the registry lost.
  patch: (manifest: Manifest) => void
}

export interface Variant {
  site: Site
  kind: 'astro' | 'kay'
  dir: string
  // Where the variant listens, then nginx in front of it over plain HTTP and over HTTP/2 with TLS.
  ports: { backend: number, http: number, https: number }
}

interface Manifest {
  dependencies: Record<string, string>
}

// The site repositories sit beside this one, as in ~/Workspace.
export const REPOS = resolve(process.env.SITES_DIR ?? join(import.meta.dir, '../../..'))
// Outside any project: inside this repository, the sites' Tailwind and Vite would scan kay's own files, and kay's tests would scan the sites'.
export const WORK = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'kay-bench-sites')
// The last @kaynooo/solidjs the jb-peinture Astro site ran on, gone from the registry: built from its tag instead.
const SOLIDJS_TAG = 'v1.19.3'

export const SITES: Site[] = [
  {
    name: 'cromignon24',
    astro: 'fd11fb0',
    pages: ['/', '/presentation', '/hotel-canin', '/hotel-felin', '/visite-domicile', '/promenade', '/tarifs', '/contact', '/legals'],
    env: {},
    patch: (manifest) => {
      delete manifest.dependencies['@kaynooo/utils']
    },
  },
  {
    name: 'jb-peinture',
    astro: '6b8c6e5',
    pages: ['/', '/a-propos', '/peinture', '/ravalement', '/revetements', '/mentions-legales', '/politique-de-confidentialite'],
    env: { CLIENT_URL: 'jb.kaynooo.fr' },
    patch: (manifest) => {
      manifest.dependencies['@kaynooo/utils'] = '^2.27.0'
      manifest.dependencies['@kaynooo/solidjs'] = `file:${join(WORK, 'solidjs')}`
    },
  },
]

export const VARIANTS: Variant[] = SITES.flatMap((site, index) => (['astro', 'kay'] as const).map((kind, offset) => {
  const slot = index * 2 + offset + 1

  return { site, kind, dir: join(WORK, `${site.name}-${kind}`), ports: { backend: 47200 + slot, http: 47080 + slot, https: 47440 + slot } }
}))

export function run(cmd: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const output = result.stdout.toString() + result.stderr.toString()

  if (result.exitCode !== 0)
    throw new Error(`${cmd.join(' ')} failed in ${cwd}:\n${output.slice(-2000)}`)

  return output
}

function exportCommit(repo: string, ref: string, dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = Bun.spawnSync(['git', '-C', repo, 'archive', ref], { stdout: 'pipe', stderr: 'pipe' })

  if (archive.exitCode !== 0)
    throw new Error(`git archive ${ref} failed in ${repo}:\n${archive.stderr.toString()}`)

  const extract = Bun.spawnSync(['tar', '-x', '-C', dir], { stdin: archive.stdout, stderr: 'pipe' })

  if (extract.exitCode !== 0)
    throw new Error(`extracting ${repo} at ${ref} failed:\n${extract.stderr.toString()}`)
}

function buildSolidjs() {
  const dir = join(WORK, 'solidjs')

  if (existsSync(join(dir, 'dist')))
    return

  exportCommit(join(REPOS, 'solidjs'), SOLIDJS_TAG, dir)
  // Its lockfile pins @kaynooo/utils versions the registry lost; its ranges accept the current ones.
  rmSync(join(dir, 'bun.lock'), { force: true })
  run(['bun', 'install'], dir)
  run(['bun', 'run', 'build'], dir)
}

// Exports each site at its Astro commit and at its kay ref and installs them; build.ts then builds them as they deploy.
export async function prepare() {
  mkdirSync(WORK, { recursive: true })
  buildSolidjs()

  for (const variant of VARIANTS) {
    const repo = join(REPOS, variant.site.name)

    exportCommit(repo, variant.kind === 'astro' ? variant.site.astro : process.env.KAY_REF ?? 'HEAD', variant.dir)

    if (variant.kind === 'astro') {
      const file = Bun.file(join(variant.dir, 'package.json'))
      const manifest = await file.json() as Manifest

      variant.site.patch(manifest)
      await Bun.write(file, JSON.stringify(manifest, null, 2))
    }

    run(['bun', 'install'], variant.dir)
  }
}

export function commitOf(variant: Variant): string {
  const ref = variant.kind === 'astro' ? variant.site.astro : process.env.KAY_REF ?? 'HEAD'

  return run(['git', '-C', join(REPOS, variant.site.name), 'rev-parse', '--short', ref], WORK).trim()
}

export async function kayVersion(variant: Variant): Promise<string> {
  const manifest = await Bun.file(join(variant.dir, 'node_modules/kay/package.json')).json() as { version: string }

  return manifest.version
}

export function label(variant: Variant): string {
  return `${variant.site.name} ${variant.kind}`
}
