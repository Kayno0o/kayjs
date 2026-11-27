import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from 'node:zlib'
import { build } from '../src/build/index'
import { show } from '../src/dom/extras'
import { hydrate, template } from '../src/dom/index'
import { loop } from '../src/dom/loop'
import { computed, effect, onCleanup, root, signal, store } from '../src/index'
import { createOwner, disposeOwner, getOwner } from '../src/reactivity/index'
import { createServer } from '../src/server/index'

const tempDirs: string[] = []

function makeTempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'src/routes'), { recursive: true })
  return dir
}

afterAll(() => {
  for (const dir of tempDirs)
    rmSync(dir, { recursive: true, force: true })
})

describe('audit #3526 — Box 30: plain component rendering an island & imported by an island', () => {
  test('emits <kay-island> on static page and avoids nested <kay-island> inside outer island', async () => {
    const dir = makeTempProject('kay-audit-box30-')
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/components/InnerCounter.tsx'), `
      import { signal } from '@kayjs/kay'
      export function InnerCounter({ start = 0 }: { start?: number }) {
        const count = signal(start)
        return <button class="inner" onClick={() => { count.value++ }}>Inner {count.value}</button>
      }
    `)

    writeFileSync(join(dir, 'src/components/Card.tsx'), `
      import { InnerCounter } from './InnerCounter'
      export function Card({ title }: { title: string }) {
        return <section class="card"><h2>{title}</h2><InnerCounter start={5} /></section>
      }
    `)

    writeFileSync(join(dir, 'src/components/OuterPanel.tsx'), `
      import { signal } from '@kayjs/kay'
      import { Card } from './Card'
      export function OuterPanel() {
        const open = signal(true)
        return (
          <div class="outer">
            <button class="toggle" onClick={() => { open.value = !open.value }}>Toggle</button>
            {open.value && <Card title="Inside Outer" />}
          </div>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Card } from '../components/Card'
      export default function StaticHome() {
        return <main><Card title="On Static Page" /></main>
      }
    `)

    writeFileSync(join(dir, 'src/routes/outer.tsx'), `
      import { OuterPanel } from '../components/OuterPanel'
      export default function OuterPage() {
        return <main><OuterPanel /></main>
      }
    `)

    const manifest = await build({ root: dir, minify: false, prerender: false })

    // InnerCounter must still be discovered as an island with its own client chunk
    const innerEntry = Object.entries(manifest.islands).find(([k]) => k.includes('InnerCounter'))
    expect(innerEntry).toBeDefined()
    const outerEntry = Object.entries(manifest.islands).find(([k]) => k.includes('OuterPanel'))
    expect(outerEntry).toBeDefined()

    const app = await createServer({ root: dir })

    // Static page rendering <Card /> must contain <kay-island> for InnerCounter
    const staticRes = await app.handle(new Request('http://localhost/'))
    expect(staticRes.status).toBe(200)
    const staticHtml = await staticRes.text()
    expect(staticHtml).toContain('On Static Page')
    expect(staticHtml).toContain(`<kay-island c="${innerEntry![1]}"`)

    // OuterPanel page must contain OuterPanel's <kay-island> and NO nested <kay-island> for InnerCounter
    const outerRes = await app.handle(new Request('http://localhost/outer'))
    expect(outerRes.status).toBe(200)
    const outerHtml = await outerRes.text()
    expect(outerHtml).toContain(`<kay-island c="${outerEntry![1]}"`)
    const islandMatches = outerHtml.match(/<kay-island\b/g) ?? []
    expect(islandMatches.length).toBe(1)
  })
})

describe('audit #3526 — Box 31: outDir safety guard before rmSync', () => {
  test('refuses root, parent, /, and protected paths without deleting files', async () => {
    const dir = makeTempProject('kay-audit-box31-')
    mkdirSync(join(dir, 'public'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"safe-test"}')
    writeFileSync(join(dir, 'kay.config.ts'), 'export default {}')
    writeFileSync(join(dir, 'public/keep.txt'), 'keep-public')
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>ok</p> }')

    const badOutDirs = [
      '.',
      '..',
      '/',
      'src',
      'src/routes',
      'public',
      'package.json',
      'kay.config.ts',
    ]

    for (const outDir of badOutDirs) {
      await expect(build({ root: dir, outDir, prerender: false })).rejects.toThrow(/outDir/i)
    }

    // Also refuse an outDir that contains a custom routesDir
    mkdirSync(join(dir, 'app/pages'), { recursive: true })
    writeFileSync(join(dir, 'app/pages/index.tsx'), 'export default function P() { return <p>p</p> }')
    await expect(build({ root: dir, routesDir: 'app/pages', outDir: 'app', prerender: false })).rejects.toThrow(/outDir/i)

    // Verify none of the protected files were wiped
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    expect(existsSync(join(dir, 'kay.config.ts'))).toBe(true)
    expect(existsSync(join(dir, 'public/keep.txt'))).toBe(true)
    expect(existsSync(join(dir, 'src/routes/index.tsx'))).toBe(true)
    expect(existsSync(join(dir, 'app/pages/index.tsx'))).toBe(true)

    // Safe descendant outDir succeeds
    const manifest = await build({ root: dir, outDir: 'dist', prerender: false })
    expect(manifest.routes.length).toBe(1)
  })
})

describe('audit #3526 — Box 32: --static staging, non-200 failure, dynamic skip warning, --static --compile refusal', () => {
  test('refuses --static and --compile together before touching existing dist', async () => {
    const dir = makeTempProject('kay-audit-box32-both-')
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>hi</p> }')
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'dist/sentinel.txt'), 'untouched')

    await expect(build({ root: dir, static: true, compile: true })).rejects.toThrow(/static.*compile|compile.*static/i)
    expect(readFileSync(join(dir, 'dist/sentinel.txt'), 'utf8')).toBe('untouched')
  })

  // A failed --static export keeping the previous one: build-swap.test.ts (#3658).
  test.each([true, false])('a prerender failure (static %p) names the route and carries the page error and its stack behind one prefix (#3650)', async (isStatic) => {
    const dir = makeTempProject('kay-prerender-cause-')
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <p>ok</p> }')
    writeFileSync(join(dir, 'src/routes/broken.tsx'), `
      export const prerender = true
      export default function Broken() {
        throw new Error('render failure in Broken')
      }
    `)

    const error = await build({ root: dir, static: isStatic }).then(() => undefined, (err: unknown) => err as Error)

    expect(error?.message).toStartWith('kay build: prerender route "/broken" answered HTTP 500: render failure in Broken\n')
    expect(error?.message).toContain('at Broken')
  })

  // A dynamic page without paths() now fails --static: check-build-parity.test.ts (#3657).
  test('exports _404.tsx under --static', async () => {
    const dir = makeTempProject('kay-audit-box32-404-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), 'export default function Home() { return <h1>Home</h1> }')
    writeFileSync(join(dir, 'src/routes/_404.tsx'), 'export default function NotFound() { return <h1>404</h1> }')
    await build({ root: dir, static: true })
    expect(existsSync(join(dir, 'dist/index.html'))).toBe(true)
    expect(existsSync(join(dir, 'dist/404.html'))).toBe(true)
  })
})

describe('audit #3526 — Box 33: strict route file discovery & build-time route conflicts', () => {
  test('skips _dirs, .d.ts, test/spec files, and _-prefixed helper files', async () => {
    const dir = makeTempProject('kay-audit-box33-skip-')
    mkdirSync(join(dir, 'src/routes/_components'), { recursive: true })
    mkdirSync(join(dir, 'src/routes/api'), { recursive: true })

    writeFileSync(join(dir, 'src/routes/_components/Badge.tsx'), 'export default function Badge() { return <span>badge</span> }')
    writeFileSync(join(dir, 'src/routes/types.d.ts'), 'export interface Foo { bar: string }')
    writeFileSync(join(dir, 'src/routes/index.test.tsx'), 'export default function FakeTestRoute() { return <div /> }')
    writeFileSync(join(dir, 'src/routes/about.spec.ts'), 'export function GET() { return new Response("spec") }')
    writeFileSync(join(dir, 'src/routes/_utils.ts'), 'export function format(s: string) { return s.toUpperCase() }')
    writeFileSync(join(dir, 'src/routes/api/ping.ts'), 'export function GET() { return new Response("pong") }')
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import Badge from './_components/Badge'
      import { format } from './_utils'
      export default function Home() { return <main>{format('hello')}<Badge /></main> }
    `)

    const manifest = await build({ root: dir, prerender: false })
    const paths = manifest.routes.map(r => r.path).sort()
    expect(paths).toEqual(['/', '/api/ping'])
  })

  test('fails build on conflicting static routes (about.tsx vs about/index.tsx)', async () => {
    const dir = makeTempProject('kay-audit-box33-conflict-static-')
    mkdirSync(join(dir, 'src/routes/about'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/about.tsx'), 'export default function AboutA() { return <p>A</p> }')
    writeFileSync(join(dir, 'src/routes/about/index.tsx'), 'export default function AboutB() { return <p>B</p> }')

    await expect(build({ root: dir, prerender: false })).rejects.toThrow(/conflict/i)
  })

  test('fails build on conflicting dynamic route patterns ([id].tsx vs [slug].tsx)', async () => {
    const dir = makeTempProject('kay-audit-box33-conflict-dyn-')
    mkdirSync(join(dir, 'src/routes/users'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/users/[id].tsx'), 'export default function ById() { return <p>id</p> }')
    writeFileSync(join(dir, 'src/routes/users/[slug].tsx'), 'export default function BySlug() { return <p>slug</p> }')

    await expect(build({ root: dir, prerender: false })).rejects.toThrow(/conflict/i)
  })
})

describe('audit #3526 — Box 34: NODE_ENV=production during kay build client bundle & prerender', () => {
  test('inlines NODE_ENV=production in client bundle and sets NODE_ENV during prerender (but not in dev mode)', async () => {
    const dir = makeTempProject('kay-audit-box34-')
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/components/EnvWidget.tsx'), `
      import { signal } from '@kayjs/kay'
      export function EnvWidget() {
        const mode = signal(process.env.NODE_ENV ?? 'unset')
        return <button onClick={() => { mode.value = 'clicked' }}>{mode.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { nodeEnv } from '@kayjs/kay/server'
      import { EnvWidget } from '../components/EnvWidget'
      export const prerender = true
      export default function Home() {
        return <main data-env={nodeEnv() ?? 'unset'} data-raw-env={process.env.NODE_ENV ?? 'unset'}><EnvWidget /></main>
      }
    `)

    const prevEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV

    try {
      // Production build
      const prodManifest = await build({ root: dir, outDir: 'dist-prod', minify: false })
      // process.env.NODE_ENV is never mutated during or after build (#3606)
      expect(process.env.NODE_ENV).toBeUndefined()

      // Prerendered HTML saw nodeEnv() === 'production' via AppRuntimeContext without mutating process.env.NODE_ENV
      const prerenderedHtml = readFileSync(join(dir, 'dist-prod/prerendered/index.html'), 'utf8')
      expect(prerenderedHtml).toContain('data-env="production"')
      expect(prerenderedHtml).toContain('data-raw-env="unset"')

      // Client island chunk inlined "production" and did not leave raw process.env.NODE_ENV
      const widgetUrl = Object.values(prodManifest.islands)[0]!
      const widgetJs = readFileSync(join(dir, 'dist-prod/client', widgetUrl.replace('/_kay/', '')), 'utf8')
      expect(widgetJs).toContain('"production"')
      expect(widgetJs).not.toContain('process.env.NODE_ENV')

      // Dev mode build keeps development in client bundle and does not force production
      const devManifest = await build({ root: dir, outDir: 'dist-dev', minify: false, dev: true })
      const devHtml = readFileSync(join(dir, 'dist-dev/prerendered/index.html'), 'utf8')
      expect(devHtml).toContain('data-env="unset"')
      const devWidgetUrl = Object.values(devManifest.islands)[0]!
      const devWidgetJs = readFileSync(join(dir, 'dist-dev/client', devWidgetUrl.replace('/_kay/', '')), 'utf8')
      expect(devWidgetJs).toContain('"development"')
    }
    finally {
      if (prevEnv !== undefined)
        process.env.NODE_ENV = prevEnv
      else
        delete process.env.NODE_ENV
    }
  })

  test('#3606: concurrent production build(), dev build(), and devServer() do not mutate process.env or race', async () => {
    const { devServer } = await import('../src/dev/index')
    const prodDir = makeTempProject('kay-concurrent-prod-')
    const devDir = makeTempProject('kay-concurrent-dev-')
    const srvDir = makeTempProject('kay-concurrent-srv-')
    for (const d of [prodDir, devDir, srvDir]) {
      mkdirSync(join(d, 'src/routes'), { recursive: true })
      writeFileSync(join(d, 'src/routes/index.tsx'), `
        import { nodeEnv } from '@kayjs/kay/server'
        export const prerender = true
        export default function Home() {
          return <p data-env={nodeEnv() ?? 'unset'} data-raw-env={process.env.NODE_ENV ?? 'unset'} data-kay-dev={process.env.KAY_DEV ?? 'unset'}>ok</p>
        }
      `)
    }

    const prevNodeEnv = process.env.NODE_ENV
    const prevKayDev = process.env.KAY_DEV
    delete process.env.NODE_ENV
    delete process.env.KAY_DEV

    let srv: Awaited<ReturnType<typeof devServer>> | undefined
    try {
      const [, , started] = await Promise.all([
        build({ root: prodDir, outDir: 'dist', minify: false }),
        build({ root: devDir, outDir: 'dist', minify: false, dev: true }),
        devServer({ root: srvDir, port: 0 }),
      ])
      srv = started

      expect(process.env.NODE_ENV).toBeUndefined()
      expect(process.env.KAY_DEV).toBeUndefined()

      const prodHtml = readFileSync(join(prodDir, 'dist/prerendered/index.html'), 'utf8')
      expect(prodHtml).toContain('data-env="production"')
      expect(prodHtml).toContain('data-raw-env="unset"')
      expect(prodHtml).toContain('data-kay-dev="unset"')

      const devHtml = readFileSync(join(devDir, 'dist/prerendered/index.html'), 'utf8')
      expect(devHtml).toContain('data-env="unset"')
      expect(devHtml).toContain('data-kay-dev="unset"')

      const srvHtml = await (await fetch(srv.url)).text()
      expect(srvHtml).toContain('data-env="unset"')
      expect(srvHtml).toContain('data-kay-dev="unset"')
    }
    finally {
      srv?.stop()
      if (prevNodeEnv !== undefined)
        process.env.NODE_ENV = prevNodeEnv
      else
        delete process.env.NODE_ENV
      if (prevKayDev !== undefined)
        process.env.KAY_DEV = prevKayDev
      else
        delete process.env.KAY_DEV
    }
  })
})

describe('audit #3526 — Box 35: store write inside an effect does not subscribe it', () => {
  test('writing to a tracked store key inside an effect does not throw a reactive cycle', () => {
    const trigger = signal(0)
    const st = store<{ a: number, items: number[], opt?: string }>({ a: 0, items: [], opt: 'x' })
    const observed: number[] = []
    let counter = 0
    let writerRuns = 0

    const dispose = root((d) => {
      // Observer subscribes to st.a so dep exists in depsCache
      effect(() => {
        observed.push(st.a)
      })

      // Writer writes st.a without reading it
      effect(() => {
        trigger.value
        writerRuns++
        st.a = ++counter
      })

      return d
    })

    expect(writerRuns).toBe(1)
    expect(st.a).toBe(1)
    expect(observed).toEqual([0, 1])

    trigger.value = 1
    expect(writerRuns).toBe(2)
    expect(st.a).toBe(2)
    expect(observed).toEqual([0, 1, 2])

    // Also verify delete inside an effect does not subscribe the writer
    let keyCount = 0
    const dispose2 = root((d) => {
      effect(() => {
        keyCount = Object.keys(st).length
      })
      effect(() => {
        if (trigger.value === 2)
          delete st.opt
      })
      return d
    })
    trigger.value = 2
    expect(keyCount).toBe(2)

    dispose2()
    dispose()
  })
})

describe('audit #3526 — Box 36: disposed row owners & computeds unlink from parent and sources', () => {
  test('disposing child owners unlinks them from parent.fs immediately', () => {
    const parent = createOwner(undefined)
    const c1 = createOwner(parent)
    const c2 = createOwner(parent)
    const c3 = createOwner(parent)

    const countChildren = (o: typeof parent) => {
      let n = 0
      let cur = o.fs
      while (cur !== undefined) {
        n++
        cur = cur.no
      }
      return n
    }

    expect(countChildren(parent)).toBe(3)
    disposeOwner(c2)
    expect(countChildren(parent)).toBe(2)
    disposeOwner(c3)
    expect(countChildren(parent)).toBe(1)
    disposeOwner(c1)
    expect(countChildren(parent)).toBe(0)
    disposeOwner(parent)
  })

  test('churning 5,000 list rows in dom/loop leaves O(current_rows) child owners on parent', async () => {
    GlobalRegistrator.register()
    try {
      const items = signal<{ id: number }[]>([])
      const parentEl = document.createElement('ul')
      let rootOwner: ReturnType<typeof getOwner>

      const dispose = root((d) => {
        rootOwner = getOwner()
        loop(
          parentEl,
          null,
          () => items.value,
          item => item.id,
          (item) => {
            const li = document.createElement('li')
            li.textContent = String(item.peek().id)
            return li
          },
        )
        return d
      })

      let nextId = 1
      // Churn 5,000 rows: 500 replacements of 10 rows each
      for (let batch = 0; batch < 500; batch++) {
        const next: { id: number }[] = []
        for (let j = 0; j < 10; j++)
          next.push({ id: nextId++ })
        items.value = next
      }

      expect(parentEl.children.length).toBe(10)

      let childOwners = 0
      // The loop's own effect (flag 32) shares the list with its row owners.
      let cur = rootOwner!.fs
      while (cur !== undefined) {
        if (!(cur.f & 32))
          childOwners++
        cur = cur.no
      }
      expect(childOwners).toBe(10)

      dispose()
      expect(rootOwner!.fs).toBeUndefined()
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  // The server rendered 'a,b,c' (one marker-free list, one between range comments); the browser's data has fewer rows by the time it hydrates.
  test.each([
    ['fewer rows', ['a'], 'a'],
    ['no rows', [], ''],
  ])('hydrating a list with %s than the server rendered removes the extra server rows (#3664)', async (_name, items, shown) => {
    GlobalRegistrator.register()
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (message: string) => warnings.push(message)
    try {
      for (const html of ['<ul><li>a</li><li>b</li><li>c</li></ul>', '<ul><!--k[--><li>a</li><li>b</li><li>c</li><!--k]--><li>end</li></ul>']) {
        const host = document.createElement('div')
        host.innerHTML = html
        const list = signal(items)
        const ul = template('<ul></ul>')
        const li = template('<li></li>')
        const ranged = html.includes('k[')
        hydrate(host, () => {
          const el = ul()
          loop(el, ranged ? el.firstChild : null, () => list.value, x => x, (item) => {
            const row = li()
            row.textContent = item.peek()
            return row
          })
          return el
        })
        const rows = (): string => [...host.querySelectorAll('li')].map(n => n.textContent).filter(t => t !== 'end').join(',')

        expect(rows()).toBe(shown)
        list.value = [...items, 'z']
        expect(rows()).toBe([...items, 'z'].join(','))
        expect(host.querySelectorAll('li').length).toBe(items.length + 1 + (ranged ? 1 : 0))
      }
      expect(warnings.length).toBe(2)
      expect(warnings[0]).toContain(`removed ${3 - items.length} server node`)
    }
    finally {
      console.warn = warn
      await GlobalRegistrator.unregister()
    }
  })

  test('a branch that throws keeps the one shown before and renders again on the next run of its condition (#3664)', async () => {
    GlobalRegistrator.register()
    try {
      const host = document.createElement('div')
      const items = signal<number[]>([])
      let throws = true
      let emptyCleanups = 0
      let thrownCleanups = 0
      root(() => {
        show(host, null, () => items.value.length > 0, () => {
          if (throws) {
            throws = false
            onCleanup(() => thrownCleanups++)
            throw new Error('branch threw')
          }
          return document.createTextNode(`list ${items.peek().length}`)
        }, () => {
          onCleanup(() => emptyCleanups++)
          return document.createTextNode('empty')
        })
      })

      expect(() => {
        items.value = [1]
      }).toThrow('branch threw')
      expect([host.textContent, emptyCleanups, thrownCleanups]).toEqual(['empty', 0, 1])
      items.value = [1, 2]
      expect([host.textContent, emptyCleanups]).toEqual(['list 2', 1])
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  test('a row that throws leaves the list in step with the DOM and renders again on the next update (#3647)', async () => {
    GlobalRegistrator.register()
    try {
      const ul = document.createElement('ul')
      const list = signal(['a', 'b', 'c', 'd'])
      let flakyThrows = true
      let badCleanups = 0
      root(() => {
        loop(ul, null, () => list.value, x => x, (item) => {
          if (item.peek() === 'bad') {
            onCleanup(() => badCleanups++)
            throw new Error('row bad threw')
          }
          if (item.peek() === 'flaky' && flakyThrows) {
            flakyThrows = false
            throw new Error('row flaky threw')
          }
          const li = document.createElement('li')
          li.textContent = item.peek()
          return li
        })
      })
      const text = (): string => [...ul.children].map(li => li.textContent).join(',')

      expect(() => {
        list.value = ['a', 'bad', 'd', 'c']
      }).toThrow('row bad threw')
      expect(badCleanups).toBe(1)
      expect(text()).toBe('a,d,c')
      list.value = ['a', 'd', 'c']
      expect(text()).toBe('a,d,c')
      list.value = ['a', 'b', 'c', 'e']
      expect(text()).toBe('a,b,c,e')

      expect(() => {
        list.value = ['a', 'b', 'c', 'e', 'flaky']
      }).toThrow('row flaky threw')
      expect(text()).toBe('a,b,c,e')
      list.value = ['a', 'b', 'c', 'e', 'flaky']
      expect(text()).toBe('a,b,c,e,flaky')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  test('computed created inside an owner unlinks from upstream signal deps on owner disposal', () => {
    const source = signal(1)
    let computeRuns = 0
    let seen = 0
    let derivedRef: ReturnType<typeof computed<number>>

    const dispose = root((d) => {
      derivedRef = computed(() => {
        computeRuns++
        return source.value * 10
      })
      effect(() => {
        seen = derivedRef.value
      })
      return d
    })

    expect([seen, computeRuns]).toEqual([10, 1])
    const rawSource = source as unknown as { s: unknown, st: unknown, ls: unknown }
    expect(rawSource.s).toBeDefined()

    dispose()

    // Upstream source must have zero remaining subscriber links and no retained lastSub reference
    expect(rawSource.s).toBeUndefined()
    expect(rawSource.st).toBeUndefined()
    expect(rawSource.ls).toBeUndefined()

    // Updating source and reading disposed computed must not re-run or re-link
    source.value = 2
    expect(derivedRef!.value).toBe(10)
    expect(computeRuns).toBe(1)
    expect(rawSource.s).toBeUndefined()

    // Disposing an unobserved computed must also clear lastSub on its source
    const disposeUnobserved = root((d) => {
      const c = computed(() => source.value * 3)
      expect(c.value).toBe(6)
      return d
    })
    disposeUnobserved()
    expect(rawSource.ls).toBeUndefined()
  })
})

describe('audit #3526 — Box 41: build-time precompression of hashed client assets', () => {
  test('emits .br and .gz sidecars next to compressible dist/client assets (and skips in dev mode)', async () => {
    const dir = makeTempProject('kay-audit-box41-')
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/components/RichWidget.css'), `
      .rich-widget { display: flex; flex-direction: column; gap: 1rem; padding: 1.5rem; background: #fafafa; color: #111; border: 1px solid #ddd; border-radius: 8px; }
      .rich-widget .title { font-size: 1.25rem; font-weight: 700; margin: 0; }
      .rich-widget .subtitle { font-size: 0.95rem; color: #555; margin: 0; }
      .rich-widget .actions { display: flex; gap: 0.5rem; align-items: center; }
      .rich-widget button { padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; }
    `)

    writeFileSync(join(dir, 'src/components/RichWidget.tsx'), `
      import { signal } from '@kayjs/kay'
      import './RichWidget.css'
      export function RichWidget() {
        const count = signal(0)
        return (
          <div class="rich-widget">
            <h2 class="title">Interactive Widget Heading For Compression</h2>
            <p class="subtitle">Repeated content helps compression: alpha beta gamma delta alpha beta gamma delta</p>
            <div class="actions">
              <button onClick={() => { count.value++ }}>Increment counter value: {count.value}</button>
            </div>
          </div>
        )
      }
    `)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { RichWidget } from '../components/RichWidget'
      export default function Home() { return <main><RichWidget /></main> }
    `)

    // Production build emits .br and .gz sidecars
    const manifest = await build({ root: dir, outDir: 'dist-prod', minify: false, prerender: false })
    expect(manifest.assets.some(a => a.endsWith('.br') || a.endsWith('.gz'))).toBe(false)

    const clientDir = join(dir, 'dist-prod/client')
    const compressibleAssets = manifest.assets.filter(a => (a.endsWith('.js') || a.endsWith('.css')) && readFileSync(join(clientDir, a)).byteLength >= 256)
    expect(compressibleAssets.length).toBeGreaterThan(0)

    for (const rel of compressibleAssets) {
      const abs = join(clientDir, rel)
      const raw = readFileSync(abs)
      const brPath = `${abs}.br`
      const gzPath = `${abs}.gz`
      expect(existsSync(brPath)).toBe(true)
      expect(existsSync(gzPath)).toBe(true)
      const br = readFileSync(brPath)
      const gz = readFileSync(gzPath)
      expect(br.byteLength).toBeLessThan(raw.byteLength)
      expect(gz.byteLength).toBeLessThan(raw.byteLength)
      expect(Buffer.compare(brotliDecompressSync(br), raw)).toBe(0)
      expect(Buffer.compare(Buffer.from(Bun.gunzipSync(gz)), raw)).toBe(0)
    }
    // Sidecars are written once and downloaded by every visitor, so at the top quality: the largest asset's beats brotli 9
    const largest = compressibleAssets.map(rel => join(clientDir, rel)).sort((a, b) => readFileSync(b).byteLength - readFileSync(a).byteLength)[0]!
    expect(readFileSync(`${largest}.br`).byteLength).toBeLessThan(brotliCompressSync(readFileSync(largest), { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }).byteLength)

    // Dev build skips precompression for speed
    const devManifest = await build({ root: dir, outDir: 'dist-dev', minify: false, prerender: false, dev: true })
    const devClientDir = join(dir, 'dist-dev/client')
    for (const rel of devManifest.assets) {
      expect(existsSync(join(devClientDir, `${rel}.br`))).toBe(false)
      expect(existsSync(join(devClientDir, `${rel}.gz`))).toBe(false)
    }
  })
})
