// In-process CLI boundary & dev config regression tests for #3568.

import type { BundleReport } from '../src/build/report'
import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkJsBudget } from '../src/build/report'
import { parseCliArgs, runCli } from '../src/cli/index'
import { devServer } from '../src/dev/index'

const KAY_PKG_DIR = resolve(import.meta.dir, '..')
const UI_PLUGIN_MOD = resolve(import.meta.dir, '../../ui/src/plugin.ts')

describe('#3568 CLI argument parsing, plugin commands & dev config fidelity', () => {
  test('parseCliArgs handles built-in commands, boolean flags, --compile, --root, and unknown flags', () => {
    const cwd = '/tmp/proj'

    const buildStatic = parseCliArgs(['build', '--static', 'subapp'], cwd)
    expect(buildStatic.error).toBeUndefined()
    expect(buildStatic.flags.get('--static')).toBe(true)
    expect(buildStatic.dirArg).toBe('subapp')
    expect(buildStatic.root).toBe(resolve(cwd, 'subapp'))

    const buildCompileFlagOnly = parseCliArgs(['build', 'subapp', '--compile'], cwd)
    expect(buildCompileFlagOnly.error).toBeUndefined()
    expect(buildCompileFlagOnly.dirArg).toBe('subapp')
    expect(buildCompileFlagOnly.flags.get('--compile')).toBe(true)

    const buildCompileOut = parseCliArgs(['build', '--compile', 'dist/my-bin'], cwd)
    expect(buildCompileOut.error).toBeUndefined()
    expect(buildCompileOut.dirArg).toBeUndefined()
    expect(buildCompileOut.flags.get('--compile')).toBe('dist/my-bin')

    const pluginCmd = parseCliArgs(['ui-eject', 'editorial', 'src/styles/ui.css'], cwd)
    expect(pluginCmd.isBuiltin).toBe(false)
    expect(pluginCmd.root).toBe(resolve(cwd))
    expect(pluginCmd.pluginArgs).toEqual(['editorial', 'src/styles/ui.css'])

    const pluginWithRoot = parseCliArgs(['ui-eject', '--root', 'apps/web', 'editorial', 'src/ui.css'], cwd)
    expect(pluginWithRoot.root).toBe(resolve(cwd, 'apps/web'))
    expect(pluginWithRoot.pluginArgs).toEqual(['editorial', 'src/ui.css'])

    const unknownFlag = parseCliArgs(['dev', '--bogus'], cwd)
    expect(unknownFlag.error).toContain('unknown option "--bogus"')
  })

  test('runCli runs plugin commands with positional arguments (kay ui-eject editorial src/styles/ui.css)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3568-cli-'))
    const logs: string[] = []
    const errs: string[] = []
    try {
      writeFileSync(join(dir, 'kay.config.ts'), `
import { ui } from ${JSON.stringify(UI_PLUGIN_MOD)}
export default { plugins: [ui({ grammar: 'editorial' })] }
`)
      const code = await runCli(['ui-eject', 'editorial', 'src/styles/ui.css'], {
        cwd: dir,
        stdout: l => logs.push(l),
        stderr: l => errs.push(l),
      })
      expect(code).toBe(0)
      expect(errs).toEqual([])
      expect(existsSync(join(dir, 'src/styles/ui.css'))).toBe(true)
      expect(readFileSync(join(dir, 'src/styles/ui.css'), 'utf8')).toContain('@layer kui')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('runCli runs built-in new, check, and build commands in-process and rejects invalid ports / unknown commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3568-builtin-'))
    const logs: string[] = []
    const errs: string[] = []
    try {
      const appDir = join(dir, 'demo-app')
      const newCode = await runCli(['new', 'demo-app', '--template', 'minimal'], {
        cwd: dir,
        stdout: l => logs.push(l),
        stderr: l => errs.push(l),
      })
      expect(newCode).toBe(0)
      expect(existsSync(join(appDir, 'src/routes/index.tsx'))).toBe(true)
      mkdirSync(join(appDir, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(KAY_PKG_DIR, join(appDir, 'node_modules/@kayjs/kay'), 'dir')

      const checkCode = await runCli(['check', 'demo-app', '--no-typecheck'], {
        cwd: dir,
        stdout: l => logs.push(l),
        stderr: l => errs.push(l),
      })
      expect(checkCode).toBe(0)

      const buildCode = await runCli(['build', 'demo-app'], {
        cwd: dir,
        stdout: l => logs.push(l),
        stderr: l => errs.push(l),
      })
      expect(buildCode).toBe(0)
      expect(existsSync(join(appDir, 'dist/manifest.json'))).toBe(true)

      const badPortCode = await runCli(['dev', '--port', 'notanumber'], {
        cwd: appDir,
        stdout: l => logs.push(l),
        stderr: l => errs.push(l),
      })
      expect(badPortCode).toBe(1)
      expect(errs.some(e => e.includes('invalid port'))).toBe(true)

      const unknownCode = await runCli(['nonexistent-cmd'], {
        cwd: appDir,
        stdout: l => logs.push(l),
        stderr: l => errs.push(l),
      })
      expect(unknownCode).toBe(1)
      expect(errs.some(e => e.includes('unknown command "nonexistent-cmd"'))).toBe(true)
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
    'src/components/Clicker.tsx': 'import { count } from \'../stores/count\'\nexport function Clicker() { return <button type="button" onClick={() => count.value++}>Add</button> }\n',
    'src/components/Total.tsx': 'import { count } from \'../stores/count\'\nexport function Total() { return <output>{count.value}</output> }\n',
    'src/components/Later.tsx': 'export const hydrate = \'visible\'\nexport function Later() { return <button type="button" onClick={() => alert(1)}>Later</button> }\n',
    'src/routes/index.tsx': 'import { Clicker } from \'../components/Clicker\'\nimport { Later } from \'../components/Later\'\nimport { Total } from \'../components/Total\'\nexport default function Home() { return <main><Clicker /><Total /><Later /></main> }\n',
    'src/routes/about.tsx': 'export default function About() { return <p>About</p> }\n',
  }

  test('--analyze lists each island with why it is one, and --max-js fails a route over the size, naming its eager islands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kay-3585-'))
    const errs: string[] = []
    const io = { cwd: dir, stdout: () => {}, stderr: (line: string) => errs.push(line) }
    const logs: string[] = []
    const log = spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
    try {
      for (const [file, text] of Object.entries(app)) {
        mkdirSync(join(dir, file, '..'), { recursive: true })
        writeFileSync(join(dir, file), text)
      }
      mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
      symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/@kayjs/kay'), 'dir')

      await expect(runCli(['build', '--analyze', '--max-js', '1000'], io)).rejects.toThrow(/^kay build: eager JS over --max-js 0\.98 KB \(gzip\) on one route:\n {2}\/ ships \d+\.\d\d KB of eager JS: Clicker \(src\/components\/Clicker\.tsx\) uses onClick; Total \(src\/components\/Total\.tsx\) reads count from '\.\.\/stores\/count'\nDefer an island/)
      const report = logs.join('\n').split('\n')
      expect(report.filter(line => line.startsWith('  island'))).toEqual([
        '  island: Clicker (src/components/Clicker.tsx) uses onClick',
        '  island, deferred: Later (src/components/Later.tsx) uses onClick',
        '  island: Total (src/components/Total.tsx) reads count from \'../stores/count\'',
      ])

      expect(await runCli(['build', '--max-js', '100KB'], io)).toBe(0)
      expect(await runCli(['build', '--max-js', 'lots'], io)).toBe(1)
      expect(errs).toEqual(['kay: invalid --max-js "lots": give the gzipped size of a route\'s eager JS in bytes or KB, e.g. --max-js 40kb'])
    }
    finally {
      log.mockRestore()
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
