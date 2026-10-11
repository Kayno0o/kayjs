import type { Site, Variant } from './sites'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { envOf, staleWarning, wantedSource } from './sites'

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

describe('SITES', () => {
  it('loads a config importing another checkout\'s copy of sites.ts, which reads none itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-bench-config-'))
    const config = join(dir, 'sites.config.ts')

    mkdirSync(join(dir, 'other'))
    copyFileSync(join(import.meta.dir, 'sites.ts'), join(dir, 'other/sites.ts'))
    writeFileSync(config, `import { SITES } from './other/sites'\n\nexport default [{ name: \`bakery \${SITES.length}\`, repo: '.', astro: '', pages: [] }]\n`)

    const child = Bun.spawnSync([process.execPath, '-e', `const { SITES } = await import(${JSON.stringify(join(import.meta.dir, 'sites.ts'))}); console.log(SITES.map(site => site.name).join())`], { env: { ...process.env, SITES_CONFIG: config }, timeout: 5000 })

    expect({ code: child.exitCode, out: child.stdout.toString().trim() }).toEqual({ code: 0, out: 'bakery 0' })
  })
})
