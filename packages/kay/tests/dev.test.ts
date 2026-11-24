import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, createBuildCache } from '../src/build/index'
import { devServer } from '../src/dev/index'

const KAY_PKG_DIR = join(import.meta.dir, '..')
const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/kay'), 'dir')
}

async function readNextSseData(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 4000): Promise<string> {
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(10, deadline - Date.now())
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`SSE timeout, received: ${JSON.stringify(buf)}`)), remaining)),
    ])
    if (chunk.done)
      throw new Error(`SSE stream closed early, received: ${JSON.stringify(buf)}`)
    buf += dec.decode(chunk.value)
    const m = /data: ([^\n]+)\n\n/.exec(buf)
    if (m !== null)
      return m[1]!
  }
  throw new Error(`SSE timeout, received: ${JSON.stringify(buf)}`)
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('Incremental BuildCache & kay dev (#3520)', () => {
  it('reuses cached OXC analysis and compiled DOM/SSR outputs for unchanged files and invalidates edited files', async () => {
    const dir = makeTemp('kay-build-cache-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    const counterPath = join(dir, 'src/components/Counter.tsx')
    const pagePath = join(dir, 'src/routes/index.tsx')
    writeFileSync(counterPath, `
      import { signal } from 'kay'
      export function Counter() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>Count {n.value}</button>
      }
    `)
    writeFileSync(pagePath, `
      import { Counter } from '../components/Counter'
      export default async function Home() {
        return <main><h1>V1</h1><Counter /></main>
      }
    `)

    const cache = createBuildCache()
    await build({ root: dir, outDir: '.b1', minify: false, prerender: false, copyPublic: false, cache })
    expect(cache.analyses.has(pagePath)).toBe(true)
    expect(cache.analyses.has(counterPath)).toBe(true)
    expect(cache.domCompiled.has(counterPath)).toBe(true)
    expect(cache.ssrCompiled.has(pagePath)).toBe(true)

    const firstCounterAnalysis = cache.analyses.get(counterPath)!.analysis
    const firstPageAnalysis = cache.analyses.get(pagePath)!.analysis

    // Edit page only -> Counter analysis object stays reused, page analysis refreshes
    writeFileSync(pagePath, `
      import { Counter } from '../components/Counter'
      export default async function Home() {
        return <main><h1>Version Two Updated</h1><Counter /></main>
      }
    `)
    await build({ root: dir, outDir: '.b2', minify: false, prerender: false, copyPublic: false, cache })
    expect(cache.analyses.get(counterPath)!.analysis).toBe(firstCounterAnalysis)
    expect(cache.analyses.get(pagePath)!.analysis).not.toBe(firstPageAnalysis)
  })

  it('pushes CSS hot-swap, build-error overlay triggers over SSE, and reloads kay.config.ts live', async () => {
    const dir = makeTemp('kay-dev-live-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/styles'), { recursive: true })

    const cssPath = join(dir, 'src/styles/site.css')
    const pagePath = join(dir, 'src/routes/index.tsx')
    const configPath = join(dir, 'kay.config.ts')

    writeFileSync(cssPath, 'body { color: rgb(1, 2, 3); }\n')
    writeFileSync(configPath, `
      import { defineConfig } from 'kay/server'
      export default defineConfig({ lang: 'en' })
    `)
    writeFileSync(pagePath, `
      import '../styles/site.css'
      export default async function Home() {
        return <h1>Dev OK</h1>
      }
    `)

    const srv = await devServer({ root: dir, port: 0 })
    const ac = new AbortController()
    try {
      const html1 = await (await fetch(`${srv.url}/`)).text()
      expect(html1).toContain('<html lang="en">')
      expect(html1).toContain('<h1>Dev OK</h1>')

      // Subscribe to SSE /_kay/dev-events
      const sseRes = await fetch(`${srv.url}/_kay/dev-events`, { signal: ac.signal })
      const reader = sseRes.body!.getReader()

      // 1. Edit plain CSS -> SSE pushes css:[...] hot-swap payload (no full reload!)
      await Bun.sleep(60)
      writeFileSync(cssPath, 'body { color: rgb(4, 5, 6); }\n')
      const cssMsg = await readNextSseData(reader)
      expect(cssMsg.startsWith('css:')).toBe(true)
      const cssUrls = JSON.parse(cssMsg.slice(4)) as string[]
      expect(cssUrls.length).toBeGreaterThan(0)
      const newCss = await (await fetch(`${srv.url}${cssUrls[0]}`)).text()
      expect(newCss).toContain('#040506')

      // 2. Introduce syntax error -> SSE pushes reload & server serves error overlay (500)
      await Bun.sleep(60)
      writeFileSync(pagePath, 'export default async function Home( { return <div /> }\n')
      const errMsg = await readNextSseData(reader)
      expect(errMsg).toBe('reload')
      const errRes = await fetch(`${srv.url}/`)
      expect(errRes.status).toBe(500)
      expect(await errRes.text()).toContain('Kay Dev Build Error')

      // 3. Fix page -> SSE pushes reload & recovers to 200
      await Bun.sleep(60)
      writeFileSync(pagePath, `
        import '../styles/site.css'
        export default async function Home() {
          return <h1>Recovered</h1>
        }
      `)
      const fixMsg = await readNextSseData(reader)
      expect(fixMsg).toBe('reload')
      const recRes = await fetch(`${srv.url}/`)
      expect(recRes.status).toBe(200)
      expect(await recRes.text()).toContain('<h1>Recovered</h1>')

      // 4. Edit kay.config.ts (lang: 'en' -> 'fr') -> live config reload!
      await Bun.sleep(60)
      writeFileSync(configPath, `
        import { defineConfig } from 'kay/server'
        export default defineConfig({ lang: 'fr' })
      `)
      const cfgMsg = await readNextSseData(reader)
      expect(cfgMsg).toBe('reload')
      const frHtml = await (await fetch(`${srv.url}/`)).text()
      expect(frHtml).toContain('<html lang="fr">')

      ac.abort()
    }
    finally {
      ac.abort()
      srv.stop()
    }
  })
})
