import type { Site, Variant } from './sites'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildCommands, shown } from './build'
import { authOf, BUNX, envOf, label, staleWarning, wantedSource } from './sites'

describe('wantedSource', () => {
  it('names a checkout as it reads now, a registry version with its version, and any specifier as it is', () => {
    expect(wantedSource('checkout', () => 'this checkout at 23f55e2, packed')).toBe('this checkout at 23f55e2, packed')
    expect(wantedSource('1.37.6', () => '')).toBe('the registry at 1.37.6')
    expect(wantedSource('file:/tmp/kay.tgz', () => '')).toBe('file:/tmp/kay.tgz')
  })
})

describe('staleWarning', () => {
  it('warns of an install other than the one asked for, and of uncommitted changes packed earlier', () => {
    expect(staleWarning('bakery kay', 'the registry at 1.37.6', 'the registry at 1.37.7')).toBe('SKIP_PREPARE: bakery kay runs the registry at 1.37.6, not the registry at 1.37.7; prepare again to measure that')
    expect(staleWarning('bakery kay', 'this checkout at 23f55e2 with uncommitted changes, packed', 'this checkout at 23f55e2 with uncommitted changes, packed')).toContain('runs uncommitted changes as packed by the last prepare')
    expect(staleWarning('bakery kay', 'this checkout at 23f55e2, packed', 'this checkout at 23f55e2, packed')).toBeUndefined()
  })
})

describe('envOf', () => {
  const variant = (site: Partial<Site>, kind: Variant['kind']): Variant => ({ site: { name: 'bakery', repo: '', astro: '', pages: [], ...site }, kind, dir: '', devDir: '', ports: { backend: 0, http: 0, https: 0, dev: 0, sidecar: 47561 } })

  it('gives a site\'s env as it is, one computed per variant, or none', () => {
    expect(envOf(variant({ env: { SITE_URL: 'https://bakery.example' } }, 'kay'))).toEqual({ SITE_URL: 'https://bakery.example' })
    expect(envOf(variant({ env: v => ({ DATABASE: `bakery_${v.kind}`, API_URL: `http://127.0.0.1:${v.ports.sidecar}` }) }, 'astro'))).toEqual({ DATABASE: 'bakery_astro', API_URL: 'http://127.0.0.1:47561' })
    expect(envOf(variant({}, 'kay'))).toEqual({})
  })
})

describe('a side before kay', () => {
  const before = { label: 'Elysia + Solid', build: [process.execPath, 'scripts/build-client.ts'], serve: [process.execPath, 'index.ts'], outputs: ['dist'] }
  const variant = (site: Partial<Site>, kind: Variant['kind']): Variant => ({ site: { name: 'club', repo: '', astro: '', pages: [], ...site }, kind, dir: '', devDir: '', ports: { backend: 47201, http: 0, https: 0, dev: 0, sidecar: 0 } })

  it('is named by its label, an Astro side and the kay side as before', () => {
    expect(label(variant({ before }, 'astro'))).toBe('club Elysia + Solid')
    expect(label(variant({ before }, 'kay'))).toBe('club kay')
    expect(label(variant({}, 'astro'))).toBe('club astro')
  })

  it('builds with its own command, shown as it runs, and an Astro side still with astro build', () => {
    expect(buildCommands(variant({ before }, 'astro'))).toEqual([before.build])
    expect(buildCommands(variant({}, 'astro'))).toEqual([[...BUNX, 'astro', 'build']])
    expect(shown(before.build)).toBe(`${process.execPath} scripts/build-client.ts`)
    expect(shown([...BUNX, 'kay', 'build'])).toBe('kay build')
  })

  it('carries what the site\'s auth mints for each side, none without one', async () => {
    const auth = async (v: Variant) => ({ cookie: `session=${v.kind}-${v.ports.backend}` })

    expect(await authOf(variant({ auth }, 'kay'))).toEqual({ cookie: 'session=kay-47201' })
    expect(await authOf(variant({}, 'kay'))).toEqual({})
  })
})

describe('SITES', () => {
  // Loads `sites.ts` in a child under a config of `source`, printing its sites and whether the loading flag outlived the load.
  function load(source: string): { code: number | null, out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'kay-bench-config-'))
    const config = join(dir, 'sites.config.ts')

    try {
      mkdirSync(join(dir, 'other'))
      copyFileSync(join(import.meta.dir, 'sites.ts'), join(dir, 'other/sites.ts'))
      writeFileSync(config, source)

      const child = Bun.spawnSync([process.execPath, '-e', `const names = await import(${JSON.stringify(join(import.meta.dir, 'sites.ts'))}).then(module => module.SITES.map(site => site.name).join(), error => error.message); console.log(names, Reflect.has(globalThis, Symbol.for('kay-bench-sites-config')))`], { env: { ...process.env, SITES_CONFIG: config }, timeout: 3000 })

      return { code: child.exitCode, out: child.stdout.toString().trim() }
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('loads a config importing another checkout\'s copy of sites.ts, which reads none itself', () => {
    expect(load(`import { SITES } from './other/sites'\n\nexport default [{ name: \`bakery \${SITES.length}\`, repo: '.', astro: '', pages: [] }]\n`)).toEqual({ code: 0, out: 'bakery 0 false' })
  })

  it('refuses a dev phase for a side before kay, which has no Astro dev server', () => {
    expect(load(`export default [{ name: 'club', repo: '.', astro: '', pages: [], before: { label: 'Elysia', build: [], serve: [], outputs: [] }, dev: { page: '/' } }]\n`).out).toContain('club: the dev phase runs Astro')
  })

  it('clears the loading flag when the config throws', () => {
    expect(load(`throw new Error('broken config')\n`)).toEqual({ code: 0, out: 'broken config false' })
  })
})
