import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, createBuildCache } from '../src/build/index'
import { runCli } from '../src/cli/index'
import { devServer } from '../src/dev/index'

const KAY_PKG_DIR = join(import.meta.dir, '..')
const tempDirs: string[] = []

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(KAY_PKG_DIR, join(dir, 'node_modules/@kayjs/kay'), 'dir')
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
      import { signal } from '@kayjs/kay'
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
      import { defineConfig } from '@kayjs/kay/config'
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
        import { defineConfig } from '@kayjs/kay/config'
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

  it('keeps unchanged server modules loaded across rebuilds and reloads the edited ones', async () => {
    const dir = makeTemp('kay-dev-modules-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const statePath = join(dir, 'src/state.ts')
    const otherPath = join(dir, 'src/routes/other.tsx')
    writeFileSync(statePath, `export const bootId = 'boot-' + Math.random().toString(36).slice(2)\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { bootId } from '../state'
      export default function Home() { return <p>{bootId}</p> }
    `)
    const other = (label: string) => `
      import { bootId } from '../state'
      export default function Other() { return <p>${label} {bootId}</p> }
    `
    writeFileSync(otherPath, other('v1'))

    const srv = await devServer({ root: dir, port: 0 })
    const page = async (path: string) => (await (await fetch(`${srv.url}${path}`)).text()).match(/<p>([^<]+)<\/p>/)![1]
    try {
      const boot = await page('/')
      expect(boot).toStartWith('boot-')

      writeFileSync(otherPath, other('v2'))
      await srv.rebuild()
      expect(await page('/other')).toBe(`v2 ${boot}`)
      expect(await page('/')).toBe(boot)

      writeFileSync(statePath, `export const bootId = 'edited-' + Math.random().toString(36).slice(2)\n`)
      await srv.rebuild()
      const edited = await page('/')
      expect(edited).toStartWith('edited-')
      expect(await page('/other')).toBe(`v2 ${edited}`)
    }
    finally {
      srv.stop()
    }
  })

  it('re-imports every server module when a file no bundle holds changes', async () => {
    const dir = makeTemp('kay-dev-public-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'public'), { recursive: true })
    const dataPath = join(dir, 'public/data.txt')
    writeFileSync(dataPath, 'data v1')
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { readFileSync } from 'node:fs'
      const data = readFileSync(${JSON.stringify(dataPath)}, 'utf8')
      export default function Home() { return <p>{data}</p> }
    `)

    const srv = await devServer({ root: dir, port: 0 })
    const ac = new AbortController()
    try {
      expect(await (await fetch(srv.url)).text()).toContain('<p>data v1</p>')
      const reader = (await fetch(`${srv.url}/_kay/dev-events`, { signal: ac.signal })).body!.getReader()
      await Bun.sleep(60)
      writeFileSync(dataPath, 'data v2')
      expect(await readNextSseData(reader)).toBe('reload')
      expect(await (await fetch(srv.url)).text()).toContain('<p>data v2</p>')
    }
    finally {
      ac.abort()
      srv.stop()
    }
  })

  it('retries a server module whose import threw on the next rebuild', async () => {
    const dir = makeTemp('kay-dev-retry-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const flagPath = join(dir, 'ready.flag')
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { existsSync } from 'node:fs'
      if (!existsSync(${JSON.stringify(flagPath)}))
        throw new Error('not ready')
      export default function Home() { return <p>ready</p> }
    `)
    writeFileSync(join(dir, 'src/routes/other.tsx'), `export default function Other() { return <p>v1</p> }\n`)

    const srv = await devServer({ root: dir, port: 0 })
    try {
      expect((await fetch(srv.url)).status).toBe(500)
      writeFileSync(flagPath, '')
      writeFileSync(join(dir, 'src/routes/other.tsx'), `export default function Other() { return <p>v2</p> }\n`)
      await srv.rebuild()
      const res = await fetch(srv.url)
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('<p>ready</p>')
    }
    finally {
      srv.stop()
    }
  })

  it('re-runs kay.config.ts only when it changes', async () => {
    const dir = makeTemp('kay-dev-config-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const configPath = join(dir, 'kay.config.ts')
    const routePath = join(dir, 'src/routes/index.tsx')
    const counter = Symbol.for(`kay.test.configRuns.${dir}`)
    const runs = (): number => (globalThis as Record<symbol, number>)[counter] ?? 0
    const config = (lang: string) => `
      const key = Symbol.for(${JSON.stringify(`kay.test.configRuns.${dir}`)})
      globalThis[key] = (globalThis[key] ?? 0) + 1
      export default { lang: '${lang}' }
    `
    writeFileSync(configPath, config('en'))
    writeFileSync(routePath, `export default function Home() { return <p>v1</p> }\n`)

    const srv = await devServer({ root: dir, port: 0 })
    try {
      const atStart = runs()
      expect(atStart).toBeGreaterThan(0)

      writeFileSync(routePath, `export default function Home() { return <p>v2</p> }\n`)
      await srv.rebuild()
      expect(runs()).toBe(atStart)

      writeFileSync(configPath, config('fr'))
      await srv.rebuild()
      expect(runs()).toBeGreaterThan(atStart)
      expect(await (await fetch(srv.url)).text()).toContain('lang="fr"')
    }
    finally {
      srv.stop()
    }
  })
})

describe('kay dev with a broken kay.config.ts (#3584)', () => {
  function appWithConfig(config: string): string {
    const dir = makeTemp('kay-dev-broken-config-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>Home</p> }\n')
    writeFileSync(join(dir, 'src/plugin.ts'), 'export function badPlugin(): never {\n  throw new Error(\'plugin factory broke\')\n}\n')
    writeFileSync(join(dir, 'kay.config.ts'), config)
    return dir
  }

  it('fails with the config\'s error at the config line that threw', async () => {
    const dir = appWithConfig('import { badPlugin } from \'./src/plugin\'\nexport default {\n  plugins: [badPlugin()],\n}\n')
    await expect(devServer({ root: dir, port: 0 })).rejects.toThrow('kay: kay.config.ts:3:13: plugin factory broke')
    expect(process.env.KAY_DEV).toBeUndefined()
  })

  it('fails with the syntax error and its position, from the CLI too', async () => {
    const dir = appWithConfig('export default {\n  port: 3000\n  lang: \'fr\',\n}\n')
    const lines: string[] = []
    const err = spyOn(process.stderr, 'write').mockImplementation((text: string | Uint8Array) => { lines.push(String(text)); return true })
    try {
      expect(await runCli(['dev', dir, '--port', '0'])).toBe(1)
    }
    finally {
      err.mockRestore()
    }
    expect(lines.join('')).toContain('kay dev: kay.config.ts:3:3: Expected "}" but found "lang"')
  })
})

describe('#3633 kay dev config propagation, cleanup, shutdown race, and dynamic watchers', () => {
  it('forwards maxRequestBodySize to createServer and cleans stale .kay-dev on startup', async () => {
    const dir = makeTemp('kay-3633-dev-body-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, '.kay-dev/stale-b99'), { recursive: true })
    writeFileSync(join(dir, '.kay-dev/stale-b99/old.txt'), 'stale')
    writeFileSync(join(dir, 'src/routes/upload.ts'), `
      export const csrf = false
      export async function POST({ request }: { request: Request }) {
        const text = await request.text()
        return Response.json({ bytes: text.length })
      }
    `)

    // > 1 MB limit forwarded to createServer (default is 1 MB; would 413 without forwarding!)
    const srv = await devServer({ root: dir, port: 0, maxRequestBodySize: 2 * 1024 * 1024 })
    try {
      expect(existsSync(join(dir, '.kay-dev/stale-b99'))).toBe(false)
      const bigBody = 'x'.repeat(1_200_000)
      const res = await fetch(`${srv.url}/upload`, { method: 'POST', body: bigBody })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ bytes: 1_200_000 })
    }
    finally {
      await srv.stop()
    }
    expect(existsSync(join(dir, '.kay-dev'))).toBe(false)
  })

  it('awaits in-flight rebuild and currentApp.dispose() before removing .kay-dev on stop()', async () => {
    const dir = makeTemp('kay-3633-dev-stop-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const disposeFlag = join(dir, 'disposed.flag')
    writeFileSync(join(dir, 'kay.config.ts'), `
      import { writeFileSync } from 'node:fs'
      export default {
        plugins: [{
          name: 'slow-dispose',
          server(api) {
            api.onShutdown(async () => {
              await Bun.sleep(40)
              writeFileSync(${JSON.stringify(disposeFlag)}, 'ok')
            })
          },
        }],
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>v1</p> }\n')

    const srv = await devServer({ root: dir, port: 0 })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>v2</p> }\n')
    const rebuildPromise = srv.rebuild()
    await srv.stop()
    await rebuildPromise

    expect(existsSync(disposeFlag)).toBe(true)
    expect(existsSync(join(dir, '.kay-dev'))).toBe(false)
  })

  it('attaches watchers when public/ is created after startup and when kay.config.ts changes routesDir', async () => {
    const dir = makeTemp('kay-3633-dev-watchers-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>orig</p> }\n')
    writeFileSync(join(dir, 'kay.config.ts'), 'export default {}\n')

    const srv = await devServer({ root: dir, port: 0 })
    try {
      // 1. Create public/ after startup and write a file inside it
      await Bun.sleep(60)
      mkdirSync(join(dir, 'public'), { recursive: true })
      writeFileSync(join(dir, 'public/hello.txt'), 'pub-v1')

      let pubText = ''
      const deadline1 = Date.now() + 4000
      while (Date.now() < deadline1) {
        const res = await fetch(`${srv.url}/hello.txt`)
        if (res.status === 200) {
          pubText = await res.text()
          if (pubText === 'pub-v1')
            break
        }
        await Bun.sleep(40)
      }
      expect(pubText).toBe('pub-v1')

      // 2. Change routesDir in kay.config.ts -> subsequent edits in new routesDir auto-rebuild
      mkdirSync(join(dir, 'pages'), { recursive: true })
      const altIndex = join(dir, 'pages/index.tsx')
      writeFileSync(altIndex, 'export default function Alt() { return <p>alt-v1</p> }\n')
      await Bun.sleep(60)
      writeFileSync(join(dir, 'kay.config.ts'), `export default { routesDir: 'pages' }\n`)

      let html = ''
      const deadline2 = Date.now() + 4000
      while (Date.now() < deadline2) {
        html = await (await fetch(srv.url)).text()
        if (html.includes('alt-v1'))
          break
        await Bun.sleep(40)
      }
      expect(html).toContain('alt-v1')

      await Bun.sleep(60)
      writeFileSync(altIndex, 'export default function Alt() { return <p>alt-v2</p> }\n')
      const deadline3 = Date.now() + 4000
      while (Date.now() < deadline3) {
        html = await (await fetch(srv.url)).text()
        if (html.includes('alt-v2'))
          break
        await Bun.sleep(40)
      }
      expect(html).toContain('alt-v2')
    }
    finally {
      await srv.stop()
    }
  })
})
