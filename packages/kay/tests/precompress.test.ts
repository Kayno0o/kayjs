import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { distLocator, measureFirstLoad } from '../src/build/first-load'
import { brotliCacheDir, brotliSize, precompressFiles, pruneBrotliCache } from '../src/build/precompress'
import { createAppContext, runWithAppContext } from '../src/plugins/context'

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

const DAY = 86_400_000
const PAGE = `<!doctype html><main>${'<p>The same paragraph, again and again.</p>'.repeat(40)}</main>`

function pageIn(dir: string, name: string, html = PAGE): string {
  const file = join(dir, name)
  writeFileSync(file, html)
  return file
}

function backdate(file: string, days: number): void {
  const at = new Date(Date.now() - days * DAY)
  utimesSync(file, at, at)
}

describe('brotli cache of the sidecars (#3684)', () => {
  it('writes the .br of a content compressed before from the cache, without compressing it again', async () => {
    const root = makeTemp('kay-3684-')
    await precompressFiles([pageIn(root, 'a.html')], 128, root)
    const [entry] = readdirSync(brotliCacheDir(root))
    writeFileSync(join(brotliCacheDir(root), entry!), 'from the cache')

    const again = pageIn(root, 'b.html')
    await precompressFiles([again], 128, root)

    expect(readFileSync(`${again}.br`, 'utf8')).toBe('from the cache')
    expect(readdirSync(brotliCacheDir(root))).toEqual([entry!])
  })

  it('compresses a changed content of the same length anew, beside the entry of the old one', async () => {
    const root = makeTemp('kay-3684-')
    await precompressFiles([pageIn(root, 'a.html')], 128, root)
    const changed = pageIn(root, 'a.html', PAGE.replace('<main>', '<menu>'))

    await precompressFiles([changed], 128, root)

    expect(brotliDecompressSync(readFileSync(`${changed}.br`)).toString()).toBe(PAGE.replace('<main>', '<menu>'))
    expect(readdirSync(brotliCacheDir(root))).toHaveLength(2)
  })

  it('removes an entry no build read for 7 days and keeps a younger one', async () => {
    const root = makeTemp('kay-3684-')
    await precompressFiles([pageIn(root, 'old.html'), pageIn(root, 'young.html', `${PAGE}<footer></footer>`)], 128, root)
    const dir = brotliCacheDir(root)
    const [first, second] = readdirSync(dir)
    backdate(join(dir, first!), 8)
    backdate(join(dir, second!), 6)

    expect(pruneBrotliCache(dir)).toBe(1)
    expect(readdirSync(dir)).toEqual([second!])
  })

  it('counts a cache hit as a use, so an entry read by each build stays', async () => {
    const root = makeTemp('kay-3684-')
    await precompressFiles([pageIn(root, 'a.html')], 128, root)
    const dir = brotliCacheDir(root)
    const [entry] = readdirSync(dir)
    backdate(join(dir, entry!), 6)

    await precompressFiles([pageIn(root, 'b.html')], 128, root)

    expect(pruneBrotliCache(dir, Date.now() + 2 * DAY)).toBe(0)
  })

  it('prunes the stale entries when a build writes its sidecars', async () => {
    const root = makeTemp('kay-3684-')
    await precompressFiles([pageIn(root, 'a.html')], 128, root)
    const dir = brotliCacheDir(root)
    const [entry] = readdirSync(dir)
    backdate(join(dir, entry!), 8)

    await precompressFiles([], 128, root)

    expect(readdirSync(dir)).toEqual([])
  })

  it('gives brotliSize from the cache of the app being built, and compresses outside a build', async () => {
    const root = makeTemp('kay-3684-')
    const ctx = createAppContext({ root, outDir: join(root, 'dist'), publicDir: join(root, 'dist/public'), assetPrefix: '/_kay', dev: false })
    await precompressFiles([pageIn(root, 'a.html')], 128, root)
    const [entry] = readdirSync(brotliCacheDir(root))
    writeFileSync(join(brotliCacheDir(root), entry!), 'twelve bytes')

    expect(await runWithAppContext(ctx, () => brotliSize(PAGE))).toBe(12)
    expect(await brotliSize(PAGE)).toBe(readFileSync(join(root, 'a.html.br')).byteLength)
  })

  it('measures the first load of an asset with no sidecar from the same cache', async () => {
    const root = makeTemp('kay-3684-')
    const ctx = createAppContext({ root, outDir: join(root, 'dist'), publicDir: join(root, 'dist/public'), assetPrefix: '/_kay', dev: false })
    await precompressFiles([pageIn(root, 'seed.css', `p{color:red}${'.a{margin:0}'.repeat(60)}`)], 128, root)
    const [entry] = readdirSync(brotliCacheDir(root))
    writeFileSync(join(brotliCacheDir(root), entry!), 'twelve bytes')
    const clientDir = join(root, 'client')
    mkdirSync(clientDir)
    writeFileSync(join(clientDir, 'app.css'), `p{color:red}${'.a{margin:0}'.repeat(60)}`)

    const load = runWithAppContext(ctx, () => measureFirstLoad(['/_kay/app.css'], distLocator({ clientDir, assetPrefix: '/_kay', publicDirs: [] })))

    expect(load.css).toBe(12)
  })

  it('keeps what the first-load measure compressed, so the sidecars written next reuse it', async () => {
    const root = makeTemp('kay-3684-')
    const ctx = createAppContext({ root, outDir: join(root, 'dist'), publicDir: join(root, 'dist/public'), assetPrefix: '/_kay', dev: false })
    const css = pageIn(root, 'app.css', `p{color:red}${'.a{margin:0}'.repeat(60)}`)

    runWithAppContext(ctx, () => measureFirstLoad(['/_kay/app.css'], distLocator({ clientDir: root, assetPrefix: '/_kay', publicDirs: [] })))

    expect(readdirSync(brotliCacheDir(root))).toHaveLength(1)
    expect(brotliDecompressSync(readFileSync(join(brotliCacheDir(root), readdirSync(brotliCacheDir(root))[0]!))).toString()).toBe(readFileSync(css, 'utf8'))
  })
})
