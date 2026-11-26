import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  analyzeFile,
  buildRatchet,
  checkMetrics,
  MAX_FILE_LINES,
  MAX_FN_COMPLEXITY,
  MAX_FN_LINES,
  type SizeRatchet,
} from '../../../scripts/size-check'

const SCRIPT = resolve(import.meta.dir, '../../../scripts/size-check.ts')
const EMPTY_RATCHET: SizeRatchet = { files: {}, functionLines: {}, functionComplexity: {} }

const tempDirs: string[] = []

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-size-check-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'packages/demo/src'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  return dir
}

function makeStatements(count: number): string {
  return Array.from({ length: count }, (_, i) => `export const v${i} = ${i}`).join('\n')
}

function makeLongFunction(name: string, bodyLines: number): string {
  const body = Array.from({ length: bodyLines }, (_, i) => `  const x${i} = ${i}`).join('\n')
  return `export function ${name}() {\n${body}\n  return x0\n}\n`
}

function makeComplexFunction(name: string, branches: number): string {
  const ifs = Array.from({ length: branches }, (_, i) => `  if (n === ${i}) return ${i}`).join('\n')
  return `export function ${name}(n: number) {\n${ifs}\n  return -1\n}\n`
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

describe('size-check metrics', () => {
  test('ignores blank lines and comment-only lines when counting code lines', () => {
    const comments = Array.from({ length: 250 }, (_, i) => `// comment ${i}`).join('\n')
    const block = `/*\n${Array.from({ length: 50 }, (_, i) => ` * doc ${i}`).join('\n')}\n */`
    const blanks = '\n'.repeat(100)
    const code = `${comments}\n${block}\n${blanks}\n${makeStatements(500)}\n`

    const metrics = analyzeFile('packages/demo/src/comments.ts', code)
    expect(metrics.lines).toBe(500)
    expect(checkMetrics([metrics], EMPTY_RATCHET).violations).toEqual([])
  })

  test('fails when a file exceeds 600 code lines', () => {
    const ok = analyzeFile('packages/demo/src/ok.ts', makeStatements(MAX_FILE_LINES))
    expect(ok.lines).toBe(MAX_FILE_LINES)
    expect(checkMetrics([ok], EMPTY_RATCHET).violations).toEqual([])

    const over = analyzeFile('packages/demo/src/over.ts', makeStatements(MAX_FILE_LINES + 1))
    expect(over.lines).toBe(MAX_FILE_LINES + 1)
    const report = checkMetrics([over], EMPTY_RATCHET)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'file',
      key: 'packages/demo/src/over.ts',
      value: MAX_FILE_LINES + 1,
      cap: MAX_FILE_LINES,
      ratcheted: false,
    })
  })

  test('fails when a function exceeds 150 code lines', () => {
    // function header + bodyLines + return + closing brace = bodyLines + 3 code lines
    const ok = analyzeFile('packages/demo/src/ok-fn.ts', makeLongFunction('atCap', MAX_FN_LINES - 3))
    expect(ok.functions[0]?.lines).toBe(MAX_FN_LINES)
    expect(checkMetrics([ok], EMPTY_RATCHET).violations).toEqual([])

    const over = analyzeFile('packages/demo/src/over-fn.ts', makeLongFunction('tooLong', MAX_FN_LINES - 2))
    expect(over.functions[0]?.lines).toBe(MAX_FN_LINES + 1)
    const report = checkMetrics([over], EMPTY_RATCHET)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'functionLines',
      key: 'packages/demo/src/over-fn.ts::tooLong',
      value: MAX_FN_LINES + 1,
      cap: MAX_FN_LINES,
      ratcheted: false,
    })
  })

  test('fails when a function exceeds cyclomatic complexity 40 and isolates nested functions', () => {
    // base 1 + 39 ifs = 40 (at cap)
    const ok = analyzeFile('packages/demo/src/ok-cx.ts', makeComplexFunction('atCap', MAX_FN_COMPLEXITY - 1))
    expect(ok.functions[0]?.complexity).toBe(MAX_FN_COMPLEXITY)
    expect(checkMetrics([ok], EMPTY_RATCHET).violations).toEqual([])

    // base 1 + 40 ifs = 41 (over cap)
    const over = analyzeFile('packages/demo/src/over-cx.ts', makeComplexFunction('tooComplex', MAX_FN_COMPLEXITY))
    expect(over.functions[0]?.complexity).toBe(MAX_FN_COMPLEXITY + 1)
    const report = checkMetrics([over], EMPTY_RATCHET)
    expect(report.violations).toHaveLength(1)
    expect(report.violations[0]).toMatchObject({
      kind: 'functionComplexity',
      key: 'packages/demo/src/over-cx.ts::tooComplex',
      value: MAX_FN_COMPLEXITY + 1,
      cap: MAX_FN_COMPLEXITY,
      ratcheted: false,
    })

    // Nested functions count their own branches separately and include ?:, &&, ||, ??, catch, switch case, loops
    const nested = analyzeFile('packages/demo/src/nested.ts', `
      export function outer(a: number, b: number) {
        const inner = (x: number) => {
          if (x > 0 && x < 10 || x === 99) {
            try {
              for (let i = 0; i < x; i++) {
                switch (i) {
                  case 1: return x ?? 0
                  default: break
                }
              }
            } catch {
              return x ? 1 : 2
            }
          }
          return 0
        }
        return a > 0 ? inner(a) : inner(b)
      }
    `)
    const outer = nested.functions.find(f => f.key === 'outer')
    const inner = nested.functions.find(f => f.key === 'outer.inner')
    expect(outer?.complexity).toBe(2) // base 1 + 1 ternary
    // base 1 + if + && + || + for + case + ?? + catch + ternary = 9
    expect(inner?.complexity).toBe(9)
  })
})

describe('size-check ratchet and --update CLI', () => {
  test('ratcheted file passes at or below cap and fails if it grows by 1 line', () => {
    const dir = makeTempProject()
    const filePath = join(dir, 'packages/demo/src/big.ts')
    writeFileSync(filePath, `${makeStatements(620)}\n`)

    // Record initial ratchet at 620 lines
    const init = runCli(['--root', dir, '--update'])
    expect(init.exitCode).toBe(0)

    // At cap (620) -> passes
    expect(runCli(['--root', dir]).exitCode).toBe(0)

    // Below cap (615) -> still passes and reports shrink opportunity
    writeFileSync(filePath, `${makeStatements(615)}\n`)
    const shrunk = runCli(['--root', dir])
    expect(shrunk.exitCode).toBe(0)
    expect(shrunk.stdout).toContain('620 -> 615')

    // Above cap by 1 line (621) -> fails
    writeFileSync(filePath, `${makeStatements(621)}\n`)
    const grown = runCli(['--root', dir])
    expect(grown.exitCode).toBe(1)
    expect(grown.stderr).toContain('packages/demo/src/big.ts: 621 code lines (ratchet 620, limit 600)')
  })

  test('--update lowers shrunk entries and removes entries that drop under the cap', async () => {
    const dir = makeTempProject()
    const filePath = join(dir, 'packages/demo/src/big.ts')
    const ratchetPath = join(dir, 'scripts/size-ratchet.json')

    writeFileSync(filePath, `${makeStatements(630)}\n`)
    expect(runCli(['--root', dir, '--update']).exitCode).toBe(0)
    let ratchet = (await Bun.file(ratchetPath).json()) as SizeRatchet
    expect(ratchet.files['packages/demo/src/big.ts']).toBe(630)

    // Shrink to 610 (still above 600) -> --update lowers ratchet to 610
    writeFileSync(filePath, `${makeStatements(610)}\n`)
    expect(runCli(['--root', dir, '--update']).exitCode).toBe(0)
    ratchet = (await Bun.file(ratchetPath).json()) as SizeRatchet
    expect(ratchet.files['packages/demo/src/big.ts']).toBe(610)

    // Shrink to 500 (under 600) -> --update removes entry completely
    writeFileSync(filePath, `${makeStatements(500)}\n`)
    expect(runCli(['--root', dir, '--update']).exitCode).toBe(0)
    ratchet = (await Bun.file(ratchetPath).json()) as SizeRatchet
    expect(ratchet.files['packages/demo/src/big.ts']).toBeUndefined()
    expect(Object.keys(ratchet.files)).toEqual([])
    expect(runCli(['--root', dir]).exitCode).toBe(0)
  })

  test('buildRatchet produces sorted deterministic entries', () => {
    const b = analyzeFile('packages/b/src/z.ts', makeStatements(605))
    const a = analyzeFile('packages/a/src/a.ts', makeStatements(610))
    const ratchet = buildRatchet([b, a])
    expect(Object.keys(ratchet.files)).toEqual(['packages/a/src/a.ts', 'packages/b/src/z.ts'])
  })
})
