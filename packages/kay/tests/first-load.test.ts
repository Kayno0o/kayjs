import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'
import type { BuildPluginContext } from '../src/plugins/index'
import { analyzeBundleWeights, build, formatBundleReport } from '../src/build/index'
import { distLocator, firstLoadUrls, measureFirstLoad } from '../src/build/first-load'

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

const brotli = (text: string): number => brotliCompressSync(Buffer.from(text), { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length
const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill)

describe('first-load weight (#3644)', () => {
  it('reads what a browser fetches from the markup: stylesheets, preloads, scripts, one icon, eager images', () => {
    const html = [
      '<link rel="icon" href="/f.ico"><link rel="icon" href="/f.svg" type="image/svg+xml">',
      '<link rel="preload" href="/_kay/a.woff2" as="font" crossorigin>',
      '<link rel="stylesheet" href="/_kay/a.css"><link rel="modulepreload" href="/_kay/m.js">',
      '<link rel="manifest" href="/m.webmanifest"><link rel="canonical" href="/x">',
      '<script type="module" src="/_kay/r.js"></script>',
      '<img src="/eager.png"><img src="/lazy.png" loading="lazy">',
    ].join('')
    expect(firstLoadUrls(html).sort()).toEqual(['/_kay/a.css', '/_kay/a.woff2', '/_kay/m.js', '/_kay/r.js', '/eager.png', '/f.svg'])
  })

  it('counts a preloaded font, a CSS url() font and a chunk a script imports, each once', () => {
    const dir = makeTemp('kay-first-load-')
    const client = join(dir, 'client')
    mkdirSync(join(client, 'fonts'), { recursive: true })
    writeFileSync(join(client, 'fonts/pre.woff2'), bytes(1000))
    writeFileSync(join(client, 'fonts/css.woff2'), bytes(2000, 9))
    writeFileSync(join(client, 'fonts/unused-fallback.woff'), bytes(4000, 3))
    const css = `@font-face{font-family:x;src:url("./fonts/css.woff2") format("woff2"),url(./fonts/unused-fallback.woff) format("woff")}@font-face{font-family:y;src:url(/_kay/fonts/pre.woff2)}${'a{color:red}'.repeat(50)}`
    const runtime = `import{a}from"./chunk.js";export{a};${'y'.repeat(2000)}`
    const chunk = `export const a=1;${'x'.repeat(3000)}`
    writeFileSync(join(client, 'a.css'), css)
    writeFileSync(join(client, 'runtime.js'), runtime)
    writeFileSync(join(client, 'chunk.js'), chunk)
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'public/logo.png'), bytes(500, 5))

    const html = '<link rel="preload" href="/_kay/fonts/pre.woff2" as="font"><link rel="stylesheet" href="/_kay/a.css"><script type="module" src="/_kay/runtime.js"></script><img src="/logo.png">'
    const result = measureFirstLoad(firstLoadUrls(html), distLocator({ clientDir: client, assetPrefix: '/_kay', publicDirs: [join(dir, 'public')] }), 123)

    expect(result.html).toBe(123)
    expect(result.fonts).toBe(3000)
    expect(result.images).toBe(500)
    expect(result.css).toBe(brotli(css))
    expect(result.js).toBe(brotli(runtime) + brotli(chunk))
    expect(result.total).toBe(result.html + result.css + result.js + result.fonts + result.images + result.other)
    expect(result.files).toBe(6)
  })

  it('reports fonts, preloads and a first-load total per route in --analyze', async () => {
    const dir = makeTemp('kay-first-load-build-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const fonts = {
      name: 'fonts',
      build(ctx: BuildPluginContext) {
        const url = ctx.emitAsset('fonts/face.woff2', bytes(6000, 11))
        ctx.addHead(`<link rel="preload" href="${url}" as="font" type="font/woff2" crossorigin>`)
        ctx.addStyle(ctx.emitAsset('fonts.css', `@font-face{font-family:f;src:url(${url}) format("woff2")}`))
      },
    }
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export default function Home() {
        return <p>Hi</p>
      }
    `)
    const outDir = join(dir, 'dist')
    const manifest = await build({ root: dir, outDir, minify: true, prerender: false, plugins: [fonts] })
    const report = analyzeBundleWeights(manifest, join(outDir, 'client'), '/_kay', undefined, undefined, [join(outDir, 'public')])
    const home = report.routes.find(r => r.path === '/')!
    // Preloaded and declared by the CSS url(): one file, counted once.
    expect(home.fonts).toBe(6000)
    expect(home.firstLoad).toBeGreaterThan(6000)
    expect(formatBundleReport(report)).toContain('First load')
  })
})
