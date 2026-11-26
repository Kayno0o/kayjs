import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  analyzeFile,
  buildRatchet,
  checkAnalyses,
  formatViolation,
  type GuardrailsRatchet,
} from '../../../scripts/guardrails-check'

const SCRIPT = resolve(import.meta.dir, '../../../scripts/guardrails-check.ts')
const EMPTY_RATCHET: GuardrailsRatchet = { emptyCatches: {} }

const tempDirs: string[] = []

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-guardrails-check-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'packages/kay/src/dom'), { recursive: true })
  mkdirSync(join(dir, 'packages/kay/src/reactivity'), { recursive: true })
  mkdirSync(join(dir, 'packages/plugin-alpha/src'), { recursive: true })
  mkdirSync(join(dir, 'packages/plugin-beta/src'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  return dir
}

function runCli(args: string[]): { exitCode: number, stdout: string, stderr: string } {
  const proc = Bun.spawnSync(['bun', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

afterEach(() => {
  while (tempDirs.length > 0)
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('guardrails-check: browser-pure module boundaries', () => {
  test('allows pure browser imports and type-only server imports', () => {
    const domAnalysis = analyzeFile('packages/kay/src/dom/action.ts', `
      import type { ActionResult } from '../server/action'
      import { type ServerAction } from '../server/action'
      import { signal } from '../reactivity/index'
      import { setAttr } from '../attrs'
      export type { ActionResult, ServerAction }
      export const state = signal(0)
      export { setAttr }
    `)
    expect(domAnalysis.violations).toEqual([])

    const contextAnalysis = analyzeFile('packages/kay/src/context.ts', `
      import type { JSX } from './jsx-runtime'
      import { signal } from './reactivity/index'
      export const ctx = signal<JSX.Element | null>(null)
    `)
    expect(contextAnalysis.violations).toEqual([])
  })

  test('rejects runtime imports from server/, build/, cli/, dev/, node:*, bun:* in dom/, reactivity/, and context.ts', () => {
    const domViolations = analyzeFile('packages/kay/src/dom/bad.ts', `
      import { run } from '../server/action'
      import '../server/side-effect'
      export { build } from '../build/index'
      export * from '../cli/check'
      const dev = import('../dev/index')
      const fs = import('node:fs')
      const db = import(\`bun:sqlite\`)
      import { hash } from 'bun'
      import { type X, y } from '../server/mixed'
      export { run, dev, fs, db, hash, y }
      export type { X }
    `)
    expect(domViolations.violations.map(v => v.kind)).toEqual(Array.from({ length: 9 }, () => 'browser-pure-import'))
    expect(domViolations.violations.map(v => v.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10])

    const reactivityViolations = analyzeFile('packages/kay/src/reactivity/bad.ts', `
      import type { Stats } from 'node:fs'
      import type { Config } from '../build/index'
      import { x } from '@kayjs/kay/server'
      export type { Stats, Config }
      export { x }
    `)
    expect(reactivityViolations.violations).toHaveLength(3)
    expect(reactivityViolations.violations.every(v => v.kind === 'browser-pure-import')).toBe(true)

    const contextViolations = analyzeFile('packages/kay/src/context.ts', `
      import { readFileSync } from 'node:fs'
      import { serve } from './server/index'
      export { readFileSync, serve }
    `)
    expect(contextViolations.violations).toHaveLength(2)
  })

  test('does not apply browser-pure restriction to server/, build/, or cli/ files', () => {
    const serverAnalysis = analyzeFile('packages/kay/src/server/index.ts', `
      import { readFileSync } from 'node:fs'
      import { Database } from 'bun:sqlite'
      import { build } from '../build/index'
      export { readFileSync, Database, build }
    `)
    expect(serverAnalysis.violations).toEqual([])
  })
})

describe('guardrails-check: cross-plugin import boundaries', () => {
  test('allows importing @kayjs/kay, @kayjs/kay/*, own package, and internal relative modules', () => {
    const analysis = analyzeFile('packages/plugin-icons/src/ambient.d.ts', `
      import type { KayPlugin } from '@kayjs/kay/config'
      import { signal } from '@kayjs/kay'
      import type { IconData } from '@kayjs/icons'
      import { helper } from './helper'
      export type { KayPlugin, IconData }
      export { signal, helper }
    `)
    expect(analysis.violations).toEqual([])
  })

  test('rejects importing another @kayjs/* plugin package or relative path into another plugin', () => {
    const analysis = analyzeFile('packages/plugin-seo/src/index.ts', `
      import { i18n } from '@kayjs/i18n'
      import type { AuthSession } from '@kayjs/auth/sqlite'
      import { Button } from '@kayjs/ui'
      export { resolveImage } from '../../plugin-images/src/index'
      const live = import('@kayjs/live/client')
      const content = import('../../plugin-content/src/collection')
      export { i18n, Button, live, content }
      export type { AuthSession }
    `)
    expect(analysis.violations).toHaveLength(6)
    expect(analysis.violations.every(v => v.kind === 'cross-plugin-import')).toBe(true)
    expect(analysis.violations.map(v => v.line)).toEqual([2, 3, 4, 5, 6, 7])
    expect(formatViolation(analysis.violations[0]!)).toContain('packages/kay/src/plugins/services.ts')
  })
})

describe('guardrails-check: type-escape guardrails', () => {
  test('rejects `as any` and `<any>` assertions while allowing `as unknown` and concrete casts', () => {
    const tsAnalysis = analyzeFile('packages/kay/src/server/escape.ts', `
      const ok1 = (1 as unknown) as string
      const ok2 = 'a' as const
      const bad1 = ok1 as any
      const bad2 = <any>ok2
      export { bad1, bad2 }
    `)
    expect(tsAnalysis.violations).toHaveLength(2)
    expect(tsAnalysis.violations[0]).toMatchObject({ kind: 'no-as-any', line: 4 })
    expect(tsAnalysis.violations[1]).toMatchObject({ kind: 'no-as-any', line: 5 })
  })

  test('rejects @ts-ignore, @ts-expect-error, and @ts-nocheck in comments but ignores string literals', () => {
    const analysis = analyzeFile('packages/kay/src/server/directives.ts', `
      const s1 = '// @ts-ignore'
      const s2 = '/* @ts-expect-error */'
      const s3 = \`@ts-nocheck\`
      // @ts-nocheck
      // @ts-ignore reason
      /* @ts-expect-error something */
      export { s1, s2, s3 }
    `)
    expect(analysis.violations).toHaveLength(3)
    expect(analysis.violations.map(v => ({ kind: v.kind, line: v.line }))).toEqual([
      { kind: 'no-ts-directive', line: 5 },
      { kind: 'no-ts-directive', line: 6 },
      { kind: 'no-ts-directive', line: 7 },
    ])
  })
})

describe('guardrails-check: empty catch ratchet and CLI', () => {
  test('detects empty catch blocks and ignores non-empty catch blocks', () => {
    const analysis = analyzeFile('packages/kay/src/server/catches.ts', `
      export function run() {
        try {
          return 1
        } catch {
          return 0
        }
      }
      export function emptyOnes() {
        try {
          JSON.parse('{')
        } catch {}
        try {
          JSON.parse('{')
        } catch (err) {
          // comment only is still empty
        }
      }
    `)
    expect(analysis.emptyCatchLines).toEqual([12, 15])
    const report = checkAnalyses([analysis], EMPTY_RATCHET)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'empty-catch',
      file: 'packages/kay/src/server/catches.ts',
      lines: [12, 15],
    })
  })

  test('ratcheted empty catches pass at/below cap, report shrinks, and fail on growth', async () => {
    const dir = makeTempProject()
    const filePath = join(dir, 'packages/kay/src/server/sample.ts')
    const ratchetPath = join(dir, 'scripts/guardrails-ratchet.json')
    mkdirSync(join(dir, 'packages/kay/src/server'), { recursive: true })

    writeFileSync(filePath, `
      export function f() {
        try { a() } catch {}
        try { b() } catch {}
      }
      function a() {}
      function b() {}
    `)

    // Without ratchet -> fails
    const initialFail = runCli(['--root', dir])
    expect(initialFail.exitCode).toBe(1)
    expect(initialFail.stderr).toContain('[empty-catch]')
    expect(initialFail.stderr).toContain('2 empty catch blocks')

    // Record ratchet at 2
    const init = runCli(['--root', dir, '--update'])
    expect(init.exitCode).toBe(0)
    let ratchet = (await Bun.file(ratchetPath).json()) as GuardrailsRatchet
    expect(ratchet.emptyCatches['packages/kay/src/server/sample.ts']).toBe(2)

    // At cap (2) -> passes
    expect(runCli(['--root', dir]).exitCode).toBe(0)

    // Shrink to 1 -> passes and prints shrink hint
    writeFileSync(filePath, `
      export function f() {
        try { a() } catch {}
      }
      function a() {}
    `)
    const shrunk = runCli(['--root', dir])
    expect(shrunk.exitCode).toBe(0)
    expect(shrunk.stdout).toContain('2 -> 1')

    // --update lowers ratchet to 1
    expect(runCli(['--root', dir, '--update']).exitCode).toBe(0)
    ratchet = (await Bun.file(ratchetPath).json()) as GuardrailsRatchet
    expect(ratchet.emptyCatches['packages/kay/src/server/sample.ts']).toBe(1)

    // Grow back to 2 -> fails against lowered ratchet of 1
    writeFileSync(filePath, `
      export function f() {
        try { a() } catch {}
        try { b() } catch {}
      }
      function a() {}
      function b() {}
    `)
    const grown = runCli(['--root', dir])
    expect(grown.exitCode).toBe(1)
    expect(grown.stderr).toContain('ratchet 1, limit 0')

    // Remove all empty catches -> --update removes entry completely
    writeFileSync(filePath, `export function f() { return 1 }\n`)
    expect(runCli(['--root', dir, '--update']).exitCode).toBe(0)
    ratchet = (await Bun.file(ratchetPath).json()) as GuardrailsRatchet
    expect(ratchet.emptyCatches).toEqual({})
    expect(runCli(['--root', dir]).exitCode).toBe(0)
  })

  test('CLI fails hard on boundary and type-escape violations even when ratchet is updated', () => {
    const dir = makeTempProject()
    writeFileSync(join(dir, 'packages/kay/src/dom/bad.ts'), `
      import { readFileSync } from 'node:fs'
      // @ts-ignore
      export const x = readFileSync as any
    `)
    writeFileSync(join(dir, 'packages/plugin-alpha/src/index.ts'), `
      import { beta } from '@kayjs/beta'
      export { beta }
    `)

    const res = runCli(['--root', dir])
    expect(res.exitCode).toBe(1)
    expect(res.stderr).toContain('[browser-pure-import]')
    expect(res.stderr).toContain('[no-ts-directive]')
    expect(res.stderr).toContain('[no-as-any]')
    expect(res.stderr).toContain('[cross-plugin-import]')
  })

  test('buildRatchet produces sorted deterministic entries', () => {
    const b = analyzeFile('packages/b/src/z.ts', 'try {} catch {}')
    const a = analyzeFile('packages/a/src/a.ts', 'try {} catch {}\ntry {} catch {}')
    const ratchet = buildRatchet([b, a])
    expect(Object.keys(ratchet.emptyCatches)).toEqual(['packages/a/src/a.ts', 'packages/b/src/z.ts'])
    expect(ratchet.emptyCatches).toEqual({
      'packages/a/src/a.ts': 2,
      'packages/b/src/z.ts': 1,
    })
  })
})
