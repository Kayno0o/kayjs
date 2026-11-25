import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devServer } from '../src/dev/index'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const repoRoot = join(import.meta.dir, '../../..')
function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/kay'))
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/@kayjs/kay'))
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('kay dev incremental client/server split, build-driven watch set, streaming & flat memory (#3548)', () => {
  it('skips client build on server-only edits and skips server build on client-only CSS edits', async () => {
    const dir = makeTemp('kay-dev-split-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/app.css'), 'body { color: rgb(1, 2, 3); }\n')
    writeFileSync(join(dir, 'src/components/Counter.tsx'), `
      import { signal } from 'kay'
      export default function Counter() {
        const count = signal(0)
        return <button onClick={() => count.value++}>{count.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import '../app.css'
      import Counter from '../components/Counter'
      export default function Home() {
        return <main><h1>v1</h1><Counter /></main>
      }
    `)

    const srv = await devServer({ root: dir, port: 0 })
    try {
      const s0 = srv.stats()
      expect(s0.clientBuilds).toBe(1)
      expect(s0.serverBuilds).toBe(1)
      expect(s0.clientSkips).toBe(0)
      expect(s0.serverSkips).toBe(0)

      // 1. Server-only edit: change static SSR route copy without touching island or CSS
      writeFileSync(join(dir, 'src/routes/index.tsx'), `
        import '../app.css'
        import Counter from '../components/Counter'
        export default function Home() {
          return <main><h1>v2-server-only</h1><Counter /></main>
        }
      `)
      await srv.rebuild()
      const s1 = srv.stats()
      expect(s1.clientBuilds).toBe(1)
      expect(s1.clientSkips).toBe(1)
      expect(s1.serverBuilds).toBe(2)
      expect(await (await fetch(srv.url)).text()).toContain('v2-server-only')

      // 2. Client-only CSS edit: server bundle is completely skipped!
      writeFileSync(join(dir, 'src/app.css'), 'body { color: rgb(9, 8, 7); }\n')
      await srv.rebuild()
      const s2 = srv.stats()
      expect(s2.clientBuilds).toBe(2)
      expect(s2.serverBuilds).toBe(2)
      expect(s2.serverSkips).toBe(1)
      const html = await (await fetch(srv.url)).text()
      const cssHref = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1]
      expect(cssHref).toBeDefined()
      expect(await (await fetch(`${srv.url}${cssHref}`)).text()).toContain('#090807')
    }
    finally {
      srv.stop()
    }
  })

  it('derives watch set from files the build actually read (including external workspace packages)', async () => {
    const dir = makeTemp('kay-dev-watch-graph-')
    const extPkgDir = makeTemp('kay-ext-pkg-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(extPkgDir, 'src'), { recursive: true })

    writeFileSync(join(extPkgDir, 'package.json'), JSON.stringify({ name: 'demo-shared', main: './src/index.ts' }))
    const extFile = join(extPkgDir, 'src/index.ts')
    writeFileSync(extFile, 'export const LABEL = "ext-v1"\n')
    symlinkSync(extPkgDir, join(dir, 'node_modules/demo-shared'))

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { LABEL } from 'demo-shared'
      export default function Home() {
        return <p>{LABEL}</p>
      }
    `)

    const srv = await devServer({ root: dir, port: 0 })
    try {
      expect(await (await fetch(srv.url)).text()).toContain('<p>ext-v1</p>')

      // Edit file OUTSIDE app `src/` inside symlinked workspace package — watcher must pick it up automatically!
      writeFileSync(extFile, 'export const LABEL = "ext-v2"\n')

      const deadline = Date.now() + 3000
      let html = ''
      while (Date.now() < deadline) {
        html = await (await fetch(srv.url)).text()
        if (html.includes('<p>ext-v2</p>'))
          break
        await Bun.sleep(40)
      }
      expect(html).toContain('<p>ext-v2</p>')
    }
    finally {
      srv.stop()
    }
  })

  it('streams <Suspense> incrementally in kay dev while still injecting the reload script', async () => {
    const dir = makeTemp('kay-dev-suspense-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Suspense } from 'kay'

      async function SlowPanel() {
        await Bun.sleep(120)
        return <section>resolved-slow-chunk</section>
      }

      export default function Home() {
        return (
          <main>
            <h1>stream-head</h1>
            <Suspense fallback={<p>loading-fallback</p>}>
              <SlowPanel />
            </Suspense>
          </main>
        )
      }
    `)

    const srv = await devServer({ root: dir, port: 0 })
    try {
      const t0 = performance.now()
      const res = await fetch(srv.url)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-length')).toBeNull()

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let firstChunkAt = -1
      let full = ''
      let sawFallbackBeforeResolved = false

      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        const chunk = decoder.decode(value, { stream: true })
        full += chunk
        if (firstChunkAt === -1 && full.includes('loading-fallback')) {
          firstChunkAt = performance.now() - t0
          if (!full.includes('resolved-slow-chunk'))
            sawFallbackBeforeResolved = true
        }
      }
      const totalMs = performance.now() - t0

      expect(sawFallbackBeforeResolved).toBe(true)
      expect(firstChunkAt).toBeLessThan(totalMs - 40)
      expect(full).toContain('resolved-slow-chunk')
      expect(full).toContain('/_kay/dev-events')
    }
    finally {
      srv.stop()
    }
  })

  it('keeps heap memory and build directories bounded over 200 saves', async () => {
    const dir = makeTemp('kay-dev-mem200-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    const routeFile = join(dir, 'src/routes/index.tsx')
    writeFileSync(routeFile, 'export default function Home() { return <p>save-0</p> }\n')

    const srv = await devServer({ root: dir, port: 0 })
    try {
      let heapAfterWarmup = 0
      for (let i = 1; i <= 200; i++) {
        writeFileSync(routeFile, `export default function Home() { return <p>save-${i}</p> }\n`)
        await srv.rebuild()
        if (i === 20) {
          Bun.gc(true)
          heapAfterWarmup = process.memoryUsage().heapUsed
        }
      }

      Bun.gc(true)
      const heapAfter200 = process.memoryUsage().heapUsed
      const growthMb = (heapAfter200 - heapAfterWarmup) / (1024 * 1024)

      // Heap growth over 180 additional saves should stay tightly bounded (flat, well under 40 MB)
      expect(growthMb).toBeLessThan(40)
      expect(await (await fetch(srv.url)).text()).toContain('save-200')

      // Old build directories are pruned (at most 2 kept + `server/`)
      const devEntries = readdirSync(join(dir, '.kay-dev'))
      const buildDirs = devEntries.filter(name => /^b\d+$/.test(name))
      expect(buildDirs.length).toBeLessThanOrEqual(2)
    }
    finally {
      srv.stop()
    }
  }, 30_000)
})
