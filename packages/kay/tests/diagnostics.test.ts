import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatBunBuildLogs } from '../src/build/files'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { parseTsx } from '../src/compiler/analyze'
import { DIAGNOSTIC_PREFIX_RE, formatCodeFrame } from '../src/compiler/shared'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Compile, check, and build error locations & code frames (#3546)', () => {
  it('syntax errors print file:line:col: error: ... and a short code frame', () => {
    const code = [
      'export default function Broken() {',
      '  const x = 1',
      '  return <div><span></div>',
      '}',
    ].join('\n')

    let errMsg = ''
    try {
      parseTsx('src/routes/broken.tsx', code)
    }
    catch (err) {
      errMsg = err instanceof Error ? err.message : String(err)
    }

    expect(errMsg).toMatch(/^src\/routes\/broken\.tsx:3:\d+: error: kay compiler: syntax error:/)
    expect(errMsg).toContain('3 |   return <div><span></div>')
    expect(errMsg).toContain('^')
    expect(DIAGNOSTIC_PREFIX_RE.test(errMsg)).toBe(true)

    const frame = formatCodeFrame('line1\nconst bad = ?\nline3', 18, 19)
    expect(frame).toContain('1 | line1')
    expect(frame).toContain('2 | const bad = ?')
    expect(frame).toContain('3 | line3')
    expect(frame).toContain('^')
  })

  it('every kay check diagnostic starts with file:line:col: error:', async () => {
    const dir = makeTemp('kay-diag-check-')
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes/posts'), { recursive: true })

    // 1. Syntax error
    writeFileSync(join(dir, 'src/components/SyntaxErr.tsx'), 'export function Broken() {\n  return <div><span></div>\n}\n')

    // 2. Interactive _layout.tsx
    writeFileSync(join(dir, 'src/routes/_layout.tsx'), [
      'import { signal } from "@kayjs/kay"',
      'export default function Layout({ children }: { children?: unknown }) {',
      '  const n = signal(0)',
      '  return <div>{n.value}{children}</div>',
      '}',
    ].join('\n'))

    // 3. Island importing server-only module
    writeFileSync(join(dir, 'src/components/BadIsland.tsx'), [
      'import { signal } from "@kayjs/kay"',
      'import { readFileSync } from "node:fs"',
      'export function BadIsland({ onDone }: { onDone?: () => void }) {',
      '  const n = signal(0)',
      '  void readFileSync',
      '  void onDone',
      '  return <button type="button" onClick={() => n.value++}>{n.value}</button>',
      '}',
    ].join('\n'))

    // 4. Server route passing function prop to island + foreign Next.js export
    writeFileSync(join(dir, 'src/routes/index.tsx'), [
      'import { BadIsland } from "../components/BadIsland"',
      'export function getStaticProps() { return {} }',
      'export default function Home() {',
      '  return <BadIsland onDone={() => {}} />',
      '}',
    ].join('\n'))

    // 5. Dynamic prerender = true without paths() + conflicting route
    writeFileSync(join(dir, 'src/routes/posts/[id].tsx'), [
      'export const prerender = true',
      'export default function ById() { return <p>id</p> }',
    ].join('\n'))
    writeFileSync(join(dir, 'src/routes/posts/[slug].tsx'), 'export default function BySlug() { return <p>slug</p> }\n')

    const res = await checkProject(dir, { skipTypecheck: true })
    expect(res.ok).toBe(false)
    expect(res.errors.length).toBeGreaterThanOrEqual(6)

    for (const err of res.errors) {
      const firstLine = err.split('\n')[0]!
      expect(firstLine).toMatch(/^[^:\s]+:\d+:\d+: error: /)
    }

    expect(res.errors.some(e => e.startsWith('src/components/SyntaxErr.tsx:2:'))).toBe(true)
    expect(res.errors.some(e => e.startsWith('src/routes/_layout.tsx:3:'))).toBe(true)
    expect(res.errors.some(e => e.startsWith('src/components/BadIsland.tsx:2:'))).toBe(true)
    expect(res.errors.some(e => e.startsWith('src/routes/index.tsx:2:'))).toBe(true)
    expect(res.errors.some(e => e.startsWith('src/routes/index.tsx:4:'))).toBe(true)
    expect(res.errors.some(e => e.startsWith('src/routes/posts/[id].tsx:1:'))).toBe(true)
    expect(res.errors.some(e => e.startsWith('src/routes/posts/[slug].tsx:1:1: error:'))).toBe(true)
  })

  it('preserves file:line:col and source line from Bun.build logs on build failures', async () => {
    // Unit test of formatBunBuildLogs
    const formatted = formatBunBuildLogs([
      {
        message: 'Could not resolve: "./missing"',
        level: 'error',
        position: {
          file: '/app/src/routes/index.tsx',
          line: 4,
          column: 19,
          length: 11,
          lineText: 'import { x } from "./missing"',
        },
      },
    ], '/app')
    expect(formatted).toContain('src/routes/index.tsx:4:19: error: Could not resolve: "./missing"')
    expect(formatted).toContain('4 | import { x } from "./missing"')
    expect(formatted).toContain('^^^^^^^^^^^')

    // Real Bun.build failure during kay build (server + client unresolved import)
    const dir = makeTemp('kay-diag-build-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), [
      'import { signal } from "@kayjs/kay"',
      'import { nope } from "./definitely-does-not-exist"',
      'export default function Home() {',
      '  const n = signal(0)',
      '  return <button type="button" onClick={() => n.value++}>{String(nope)}</button>',
      '}',
    ].join('\n'))

    let buildErr = ''
    try {
      await build({ root: dir, outDir: 'dist', prerender: false })
    }
    catch (err) {
      buildErr = err instanceof Error ? err.message : String(err)
    }

    expect(buildErr).toContain('kay build (client) failed:')
    expect(buildErr).toMatch(/src\/routes\/index\.tsx:\d+:\d+: error: Could not resolve/)
    expect(buildErr).toContain('import { nope } from "./definitely-does-not-exist"')
    expect(buildErr).toContain('^'.repeat(10))

    // Verify format matches what `errs` parses when `errs` is installed on PATH
    const errsBin = Bun.which('errs')
    if (errsBin !== null) {
      const sample = [
        'src/routes/broken.tsx:3:21: error: kay compiler: syntax error: Unexpected closing tag',
        'src/components/BadIsland.tsx:2:1: error: kay check: interactive island imports server-only module "node:fs".',
        'src/routes/index.tsx:5:22: error: Could not resolve: "./definitely-does-not-exist"',
      ].join('\n')
      const proc = Bun.spawnSync([errsBin, '--json'], { stdin: Buffer.from(`${sample}\n`) })
      const parsed = JSON.parse(proc.stdout.toString()) as { errors: Array<{ file: string, line: number, column: number }>, unrecognised: number }
      expect(parsed.unrecognised).toBe(0)
      expect(parsed.errors.length).toBe(3)
      expect(parsed.errors[0]).toMatchObject({ file: 'src/routes/broken.tsx', line: 3, column: 21 })
      expect(parsed.errors[1]).toMatchObject({ file: 'src/components/BadIsland.tsx', line: 2, column: 1 })
      expect(parsed.errors[2]).toMatchObject({ file: 'src/routes/index.tsx', line: 5, column: 22 })
    }
  })
})
