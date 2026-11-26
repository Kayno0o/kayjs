// Regression tests for #3609: every public export of @kayjs/kay and @kayjs/kay/server stays
// documented in packages/kay/llms.txt, and all 13 first-party packages ship their own llms.txt.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Glob } from 'bun'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const CORE_LLMS_PATH = join(REPO_ROOT, 'packages/kay/llms.txt')

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

describe('#3609 llms.txt export sync & first-party package coverage', () => {
  test('every public value export of @kayjs/kay and @kayjs/kay/server is documented in packages/kay/llms.txt', async () => {
    const llms = readFileSync(CORE_LLMS_PATH, 'utf8')
    const coreMod = await import('../src/index')
    const serverMod = await import('../src/server/public')

    const coreExports = Object.keys(coreMod).sort()
    const serverExports = Object.keys(serverMod).sort()
    expect(coreExports.length).toBeGreaterThan(0)
    expect(serverExports.length).toBeGreaterThan(0)

    const missingCore = coreExports.filter(name => !new RegExp(`\\b${escapeRe(name)}\\b`).test(llms))
    const missingServer = serverExports.filter(name => !new RegExp(`\\b${escapeRe(name)}\\b`).test(llms))

    expect(missingCore).toEqual([])
    expect(missingServer).toEqual([])
  })

  test('all 13 workspace packages declare llms.txt in files, ship a non-empty llms.txt, and pack it', async () => {
    const pkgPaths: string[] = []
    for await (const p of new Glob('packages/*/package.json').scan(REPO_ROOT))
      pkgPaths.push(p)
    pkgPaths.sort()
    expect(pkgPaths.length).toBe(13)

    const coreLlms = readFileSync(CORE_LLMS_PATH, 'utf8')

    for (const rel of pkgPaths) {
      const pkgDir = dirname(join(REPO_ROOT, rel))
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8')) as {
        name: string
        files?: string[]
      }

      expect(pkg.files).toContain('llms.txt')

      const llmsFile = join(pkgDir, 'llms.txt')
      expect(existsSync(llmsFile)).toBe(true)
      const content = readFileSync(llmsFile, 'utf8').trim()
      expect(content.length).toBeGreaterThan(100)
      if (pkg.name !== '@kayjs/kay') {
        expect(content).toContain(pkg.name)
        expect(coreLlms).toContain(`node_modules/${pkg.name}/llms.txt`)
      }

      const pack = Bun.spawnSync(['bun', 'pm', 'pack', '--dry-run'], {
        cwd: pkgDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(pack.exitCode).toBe(0)
      expect(pack.stdout.toString()).toMatch(/packed [\d.]+K?B llms\.txt/)
    }
  })
})
