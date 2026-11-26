// In-process CLI boundary & dev config regression tests for #3568.

import type { BundleReport } from '../src/build/report'
import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkJsBudget } from '../src/build/report'
import { runCli } from '../src/cli/index'
import { devServer } from '../src/dev/index'

const KAY_PKG_DIR = resolve(import.meta.dir, '..')
const CLI = resolve(import.meta.dir, '../src/cli/index.ts')

async function kay(args: string[], cwd = process.cwd()): Promise<{ code: number, out: string, err: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out, err }
}

const UI_PLUGIN_MOD = resolve(import.meta.dir, '../../ui/src/plugin.ts')

describe('#3568 CLI argument parsing, plugin commands & dev config fidelity', () => {
  test('--help lists the commands, and a command answers --help with its own options and exit codes', async () => {
    const top = await kay(['--help'])
    expect(top.code).toBe(0)
    expect(top.out).toContain('check')
    expect(top.out).toContain('--completions')
    const check = await kay(['check', '--help'])
    expect(check.code).toBe(0)
    expect(check.out).toContain('--no-typecheck')
    expect(check.out).toContain('Exit codes:')
    expect((await kay(['upgrade', '--help'])).out).toContain('Exit codes:')
  })

  test('an unknown option is a usage error that exits 2 and names the option', async () => {
    const res = await kay(['check', '--nope'])
    expect(res.code).toBe(2)
    expect(res.err).toContain('--nope')
    expect((await kay(['build', '--max-js', 'lots'])).code).toBe(2)
    expect((await kay(['dev', '--port', 'notanumber'])).code).toBe(2)
    expect((await kay(['new'])).code).toBe(2)
    expect((await kay(['new', 'x', '--template', 'nope'])).err).toContain('minimal')
  })

  test('a typo\'d command names the one meant and exits 2', async () => {
    const res = await kay(['chekc'])
    expect(res.code).toBe(2)
    expect(res.err).toContain('did you mean check?')
  })

  test('--completions prints a shell script', async () => {
    const res = await kay(['--completions', 'fish'])
    expect(res.code).toBe(0)
    expect(res.out).toContain('complete')
  })

  test('a plugin command runs from the CLI process, takes --root, and is listed by --help', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3593-'))
    try {
      mkdirSync(join(dir, 'app'))
      writeFileSync(join(dir, 'app/kay.config.ts'), `export default { plugins: [{ name: 'hello', commands: { hello: (args: string[], root: string) => console.log(JSON.stringify({ args, root })) } }] }\n`)
      const res = await kay(['hello', '--root', 'app', 'a', '-x'], dir)
      expect(res.code).toBe(0)
      expect(JSON.parse(res.out)).toEqual({ args: ['a', '-x'], root: join(dir, 'app') })
      expect((await kay(['--help'], join(dir, 'app'))).out).toContain('hello')
      expect((await kay(['helo'], join(dir, 'app'))).err).toContain('did you mean hello?')
      const help = await kay(['hello', '--help'], join(dir, 'app'))
      expect(help.code).toBe(0)
      expect(help.out).toContain('hello plugin')
      expect(help.out).not.toContain('"args"')
      const noRoot = await kay(['hello', '--root'], join(dir, 'app'))
      expect(noRoot.code).toBe(2)
      expect(noRoot.err).toContain('--root')
      expect(noRoot.err).not.toContain(' at ')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a kay.config.ts that fails to load leaves --help and the built-ins working, and a plugin command names the error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3593-'))
    try {
      writeFileSync(join(dir, 'kay.config.ts'), 'export default { plugins: [ }\n')
      const help = await kay(['--help'], dir)
      expect(help.code).toBe(0)
      expect(help.out).toContain('check')
      const plugin = await kay(['ui-eject'], dir)
      expect(plugin.code).toBe(1)
      expect(plugin.err).toContain('kay.config.ts')
      expect(plugin.err).not.toMatch(/^\s+at /m)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('runCli runs plugin commands with positional arguments (kay ui-eject editorial src/styles/ui.css)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3568-cli-'))
    try {
      writeFileSync(join(dir, 'kay.config.ts'), `
import { ui } from ${JSON.stringify(UI_PLUGIN_MOD)}
export default { plugins: [ui({ grammar: 'editorial' })] }
`)
      const code = await runCli(['ui-eject', 'editorial', 'src/styles/ui.css'], { cwd: dir })
      expect(code).toBe(0)
      expect(existsSync(join(dir, 'src/styles/ui.css'))).toBe(true)
      expect(readFileSync(join(dir, 'src/styles/ui.css'), 'utf8')).toContain('@layer kui')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('runCli runs built-in new, check, and build commands in-process and rejects invalid ports / unknown commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3568-builtin-'))
    try {
      const appDir = join(dir, 'demo-app')
      const newCode = await runCli(['new', 'demo-app', '--template', 'minimal'], { cwd: dir })
      expect(newCode).toBe(0)
      expect(existsSync(join(appDir, 'src/routes/index.tsx'))).toBe(true)
      mkdirSync(join(appDir, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(KAY_PKG_DIR, join(appDir, 'node_modules/@kayjs/kay'), 'dir')

      const checkCode = await runCli(['check', 'demo-app', '--no-typecheck'], { cwd: dir })
      expect(checkCode).toBe(0)

      const buildCode = await runCli(['build', 'demo-app'], { cwd: dir })
      expect(buildCode).toBe(0)
      expect(existsSync(join(appDir, 'dist/manifest.json'))).toBe(true)

      const badPortCode = await runCli(['dev', '--port', 'notanumber'], { cwd: appDir })
      expect(badPortCode).toBe(2)

      const unknownCode = await runCli(['nonexistent-cmd'], { cwd: appDir })
      expect(unknownCode).toBe(2)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('kay dev honors kay.config.ts maxRequestBodySize, routesDir, publicDir, and assetPrefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3568-dev-'))
    try {
      mkdirSync(join(dir, 'pages'), { recursive: true })
      mkdirSync(join(dir, 'static'), { recursive: true })
      writeFileSync(join(dir, 'static/hello.txt'), 'from-custom-public')
      writeFileSync(join(dir, 'pages/index.tsx'), 'export default function Home() { return <h1>custom-routes</h1> }\n')
      writeFileSync(join(dir, 'pages/echo.ts'), `
export const csrf = false
export async function POST(ctx: { request: Request }) {
  return new Response(await ctx.request.text())
}
`)
      writeFileSync(join(dir, 'kay.config.ts'), `
export default {
  routesDir: 'pages',
  publicDir: 'static',
  assetPrefix: '/_assets',
  maxRequestBodySize: 64,
}
`)

      const dev = await devServer({ root: dir, port: 0 })
      try {
        const home = await fetch(`${dev.url}/`)
        expect(home.status).toBe(200)
        const html = await home.text()
        expect(html).toContain('custom-routes')
        expect(html).toContain('/_assets/dev-events')

        const pub = await fetch(`${dev.url}/hello.txt`)
        expect(pub.status).toBe(200)
        expect(await pub.text()).toBe('from-custom-public')

        // Body exceeding maxRequestBodySize (64 bytes) is rejected by Bun.serve / kay server
        const big = await fetch(`${dev.url}/echo`, {
          method: 'POST',
          body: 'x'.repeat(256),
        })
        expect(big.status).toBe(413)
      }
      finally {
        dev.stop()
      }
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('kay build names the islands behind each route\'s JS (#3585)', () => {
  const app: Record<string, string> = {
    'src/stores/count.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n',
    'src/components/Count.tsx': 'import { count } from \'../stores/count\'\nexport function Clicker() { return <button type="button" onClick={() => count.value++}>Add</button> }\nexport function Total() { return <output>{count.value}</output> }\nexport function Label() { return <span>Count</span> }\n',
    'src/components/Later.tsx': 'export const hydrate = \'visible\'\nexport function Later() { return <button type="button" onClick={() => alert(1)}>Later</button> }\n',
    'src/routes/index.tsx': 'import { Clicker, Total } from \'../components/Count\'\nimport { Later } from \'../components/Later\'\nexport default function Home() { return <main><Clicker /><Total /><Later /></main> }\n',
    'src/routes/about.tsx': 'import { Label } from \'../components/Count\'\nexport default function About() { return <p><Label /></p> }\n',
  }

  test('--analyze lists each island with why it is one, and --max-js fails a route over the size, naming its eager islands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3585-'))
    const io = { cwd: dir }
    const errs: string[] = []
    const err = spyOn(process.stderr, 'write').mockImplementation((text: string | Uint8Array) => { errs.push(String(text)); return true })
    const logs: string[] = []
    const log = spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
    try {
      for (const [file, text] of Object.entries(app)) {
        mkdirSync(join(dir, file, '..'), { recursive: true })
        writeFileSync(join(dir, file), text)
      }
      mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/@kayjs/kay'), 'dir')

      expect(await runCli(['build', '--analyze', '--max-js', '1000'], io)).toBe(1)
      expect(errs.join('')).toMatch(/kay build: eager JS over --max-js 0\.98 KB \(gzip\) on one route:\n {2}\/ ships \d+\.\d\d KB of eager JS: Clicker \(src\/components\/Count\.tsx\) uses onClick; Total \(src\/components\/Count\.tsx\) reads count from '\.\.\/stores\/count'\nDefer an island/)
      const report = logs.join('\n').split('\n')
      expect(report.filter(line => line.startsWith('  island'))).toEqual([
        '  island: Clicker (src/components/Count.tsx) uses onClick',
        '  island: Total (src/components/Count.tsx) reads count from \'../stores/count\'',
        '  island, deferred: Later (src/components/Later.tsx) uses onClick',
      ])

      expect(await runCli(['build', '--max-js', '100KB'], io)).toBe(0)
      errs.length = 0
      expect(await runCli(['build', '--max-js', 'lots'], io)).toBe(2)
      expect(errs.join('')).toContain('invalid --max-js "lots"')
    }
    finally {
      log.mockRestore()
      err.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a route at the size passes, one byte over fails, and a route with no eager island names the runtime', () => {
    const route = (path: string, jsGzip: number, islands: BundleReport['routes'][number]['islands']) => ({ path, jsGzip, jsRaw: 0, cssRaw: 0, cssGzip: 0, jsFiles: 1, cssFiles: 0, islands })
    const report = (jsGzip: number): BundleReport => ({
      routes: [
        route('/', 2048, [{ name: 'Clicker', file: 'src/Clicker.tsx', reason: 'uses onClick', eager: true }]),
        route('/later', jsGzip, [{ name: 'Later', file: 'src/Later.tsx', reason: 'uses onClick', eager: false }]),
      ],
      totalJsGzip: 0,
      totalCssGzip: 0,
      topModules: [],
    })

    expect(() => checkJsBudget(report(1024), 2048)).not.toThrow()
    expect(() => checkJsBudget(report(4096), 2047)).toThrow('kay build: eager JS over --max-js 2.00 KB (gzip) on 2 routes:\n  / ships 2.00 KB of eager JS: Clicker (src/Clicker.tsx) uses onClick\n  /later ships 4.00 KB of eager JS: the kay runtime alone\nDefer an island with export const hydrate = \'visible\', move its state into fewer components, or raise --max-js.')
  })
})
