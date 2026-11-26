import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { analyzeModule, compileDom, compileSsr } from '../src/compiler/index'
import { SourceEditor } from '../src/compiler/patch'
import { readsPrivateEnv, SERVER_ONLY_MODULES } from '../src/compiler/server-only'
import { createContext, provideContext, useContext, useId } from '../src/context'
import * as domExtras from '../src/dom/extras'
import * as domCore from '../src/dom/index'
import * as domLoop from '../src/dom/loop'
import { effect, root, signal } from '../src/reactivity/index'
import { selector } from '../src/reactivity/selector'
import { store } from '../src/reactivity/store'
import { CookieStore } from '../src/server/cookies'
import { createServer, KAY_ISLAND_STYLE_HASH } from '../src/server/index'
import { Router } from '../src/server/router'

import { createRenderContext, runWithRenderContext } from '../src/ssr/context'
import * as ssrRt from '../src/ssr/index'
import { sanitizeMarkdownHtml } from '../../plugin-content/src/sanitize'
import { shareCard } from '../../plugin-images/src/card'

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

async function withDom<T>(fn: () => T | Promise<T>): Promise<T> {
  GlobalRegistrator.register()
  try {
    return await fn()
  }
  finally {
    await GlobalRegistrator.unregister()
  }
}

describe('Kay v2 architecture & regression suite', () => {
  it('createContext / useContext and useId work across SSR and client owner trees', async () => {
    const ThemeCtx = createContext('light')

    // 1. SSR request-scoped context & nested override
    const rctx = createRenderContext()
    const ssrResult = runWithRenderContext(rctx, () => {
      const a = useContext(ThemeCtx)
      const id0 = useId('f')
      const inner = provideContext(ThemeCtx, 'dark', () => {
        const b = useContext(ThemeCtx)
        const id1 = useId('f')
        const deeper = provideContext(ThemeCtx, 'high-contrast', () => useContext(ThemeCtx))
        return `${b}:${deeper}:${useContext(ThemeCtx)}:${id1}`
      })
      const after = useContext(ThemeCtx)
      return `${a}|${inner}|${after}|${id0}`
    })
    expect(ssrResult).toBe('light|dark:high-contrast:dark:f-1|light|f-0')

    // 2. Client owner-scoped context & deterministic island useId
    await withDom(() => {
      const host = document.createElement('div')
      let captured = ''
      const dispose = domCore.mount(host, () => {
        const first = useId('ui')
        const val = provideContext(ThemeCtx, 'orbit', () => `${useContext(ThemeCtx)}:${useId('ui')}`)
        captured = `${first}|${val}|${useContext(ThemeCtx)}`
        return document.createTextNode(captured)
      }, 'i0-')
      expect(captured).toBe('ui-i0-0|orbit:ui-i0-1|light')
      dispose()
    })
  })

  it('an island sees only the contexts provided inside it, and the server children it is handed render outside it (#3583)', async () => {
    const dir = makeTemp('kay-island-context-')
    const files: Record<string, string> = {
      'src/theme.ts': 'import { createContext } from \'@kayjs/kay\'\nexport const Theme = createContext(\'light\')\nexport const Size = createContext(\'m\')\n',
      'src/Counter.tsx': 'import { signal, useContext } from \'@kayjs/kay\'\nimport { Theme } from \'./theme\'\nexport function Counter() { const n = signal(0); return <button onClick={() => n.value++}>{useContext(Theme)}</button> }\n',
      'src/Panel.tsx': 'import type { KayChild } from \'@kayjs/kay\'\nimport { signal, useContext, useId } from \'@kayjs/kay\'\nimport { Size } from \'./theme\'\nexport function Panel(props: { children?: KayChild }) { const open = signal(true); return <section id={useId()} onClick={() => { open.value = !open.value }}><Size.Provider value="l">{useContext(Size)}{props.children}</Size.Provider></section> }\n',
      'src/Label.tsx': 'import { useContext, useId } from \'@kayjs/kay\'\nimport { Size, Theme } from \'./theme\'\nexport function Label() { return <i id={useId()}>{useContext(Theme)}-{useContext(Size)}</i> }\n',
      'src/Clicker.tsx': 'import { signal } from \'@kayjs/kay\'\nexport function Clicker() { const n = signal(0); return <b onClick={() => n.value++}>{n.value}</b> }\n',
      'src/routes/index.tsx': 'import { Theme } from \'../theme\'\nimport { Clicker } from \'../Clicker\'\nimport { Label } from \'../Label\'\nimport { Panel } from \'../Panel\'\nexport default function Home() { return <Theme.Provider value="dark"><Panel><Label /><Clicker /></Panel></Theme.Provider> }\n',
      'src/routes/counter.tsx': 'import { Theme } from \'../theme\'\nimport { Counter } from \'../Counter\'\nexport default function Page() { return <Theme.Provider value="dark"><Counter /></Theme.Provider> }\n',
    }
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), text)
    }
    await build({ root: dir })
    const errors: unknown[] = []
    const app = await createServer({ root: dir, onError: info => errors.push(info.error) })
    try {
      const page = await (await app.handle(new Request('http://localhost/'))).text()
      expect(page.slice(page.indexOf('<body>'), page.indexOf('</body>'))).toMatch(/^<body><kay-island c="[^"]+" i="i1-"><section id="k-i1-0"><!--k\[-->l<!--k\]--><!--k\[--><kay-slot><i id="k-0">dark-m<\/i><kay-island c="\/_kay\/clicker-[^"]+"><b>0<\/b><\/kay-island><\/kay-slot><!--k\]--><\/section><\/kay-island>$/)
      expect((await app.handle(new Request('http://localhost/counter'))).status).toBe(500)
      expect(errors).toEqual([new Error('kay: <Counter> reads a context provided outside the island, which the browser never sees; pass its value as a prop.')])
    }
    finally {
      await app.dispose?.()
    }
  })

  it('selector() cleans up cleanly across alternating owners without leaking refcounts', () => {
    const selected = signal('a')
    let runsA = 0
    let runsB = 0
    let disposeA!: () => void
    let disposeB!: () => void

    const sel = root(() => selector(() => selected.value))

    disposeA = root((d) => {
      effect(() => {
        if (sel.is('a'))
          runsA++
      })
      return d
    })
    disposeB = root((d) => {
      effect(() => {
        if (sel.is('a'))
          runsB++
      })
      return d
    })

    // Re-read in alternating order
    selected.value = 'b'
    selected.value = 'a'
    expect(runsA).toBe(2)
    expect(runsB).toBe(2)

    disposeA()
    disposeB()
    // Unowned read returns accurate boolean without mutating subscriptions
    expect(sel.is('a')).toBe(true)
    expect(sel.is('z')).toBe(false)
  })

  it('store() tracks reactive reads while ignoring untracked reads', () => {
    const state = store({ items: [1, 2, 3], count: 0 })
    // Untracked reads work without creating reactive side effects
    expect(state.items.map(x => x * 2)).toEqual([2, 4, 6])

    let seen = 0
    const dispose = root((d) => {
      effect(() => {
        seen = state.count + state.items.length
      })
      return d
    })
    expect(seen).toBe(3)
    state.items.push(4)
    expect(seen).toBe(4)
    state.count = 10
    expect(seen).toBe(14)
    dispose()
  })

  it('import type does not mark a file interactive, and export * barrels resolve islands', async () => {
    const analysis = analyzeModule('Page.tsx', `
      import type { signal, Signal } from '@kayjs/kay'
      export default async function Page(props: { s?: Signal<number> }) {
        return <p>{props.s ? 'yes' : 'no'}</p>
      }
    `)
    expect(analysis.isInteractive).toBe(false)
    expect(analysis.hasAsyncDefault).toBe(true)

    // Full build with `export * from './Counter'` barrel
    const dir = makeTemp('kay-export-star-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })
    writeFileSync(join(dir, 'src/components/Counter.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Counter() {
        const n = signal(0)
        return <button type="button" onClick={() => n.value++}>{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/components/index.ts'), `export * from './Counter'\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Counter } from '../components'
      export default async function Home() {
        return <main><Counter /></main>
      }
    `)

    const manifest = await build({ root: dir })
    expect(Object.keys(manifest.islands).length).toBe(1)
    const app = await createServer({ root: dir })
    const html = await (await app.handle(new Request('http://localhost/'))).text()
    expect(html).toContain('<kay-island c="')
    await app.dispose?.()
  })

  it('compiler handles scope shadowing, destructured defaults, root fragments, and overlapping patch assertion', () => {
    const src = `
      export function Demo({ err, item, title, a = 1, b = a, icon = <i>!</i> }: any = {}) {
        try {
          for (const item of [1, 2]) {
            void item
          }
        }
        catch (err) {
          void err
        }
        class Box {
          title() { return 1 }
        }
        return <section>{title}{b}{icon}{new Box().title()}</section>
      }
    `
    const dom = compileDom('Demo.tsx', src)
    expect(dom.code).toContain('catch (err)')
    expect(dom.code).toContain('for (const item of [1, 2])')
    expect(dom.code).toContain('title() { return 1 }')
    expect(dom.code).not.toContain('catch (__p.err)')
    expect(dom.code).toMatch(/__p\.icon === undefined \? __d\d+\(\) : __p\.icon/)
    expect(dom.code).toContain('__propDefault(() => (_t0()), __p.icon === undefined)')
    expect(dom.code).toContain('__p.b === undefined ? (__p.a === undefined ? 1 : __p.a) : __p.b')

    // Root JSXFragment with logical expression compiles to valid JS
    const frag = compileDom('Frag.tsx', `
      import { signal } from '@kayjs/kay'
      export function Frag() {
        const n = signal(1)
        return <>{n.value > 0 && <b>pos</b>}</>
      }
    `)
    expect(() => new Function(frag.code.replace(/^\s*import .*$/gm, '').replace(/export /g, ''))).not.toThrow()

    // Overlapping SourceEditor patch throws instead of silently dropping
    const ed = new SourceEditor('abcdef')
    ed.replace(0, 4, 'X')
    ed.replace(2, 5, 'Y')
    expect(() => ed.toString()).toThrow(/overlapping source patch/)
  })

  it('hydrates .map() + sibling, <Child /> + sibling, empty string literal, and mixed ternary reactively', async () => {
    const src = `
      function Badge({ label }) { return <b>{label}</b> }
      export function Panel({ items, show, count }) {
        return (
          <div>
            {""}
            <ul>
              {items.value.map(x => <li key={x}>{x}</li>)}
              <li class="footer">End</li>
            </ul>
            <Badge label="ok" />
            <span class="after">{show.value ? <em>yes</em> : count.value}</span>
          </div>
        )
      }
    `
    const ssrCompiled = compileSsr('Panel.tsx', src, { isIsland: true })
    const domCompiled = compileDom('Panel.tsx', src)

    await withDom(() => {
      const items = signal(['A', 'B'])
      const show = signal(false)
      const count = signal(7)

      const ssrBody = ssrCompiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const makeSsr = new Function('__raw', '__esc', '__ssrChild', '__ssrLoop', 'items', 'show', 'count', `${ssrBody}\nreturn Panel({ items, show, count }).__html`)
      const html = makeSsr(ssrRt.raw, ssrRt.esc, ssrRt.ssrChild, ssrRt.ssrLoop, items, show, count) as string

      const host = document.createElement('div')
      host.innerHTML = html
      const originalFooter = host.querySelector('.footer')!
      const originalBadge = host.querySelector('b')!
      expect(originalFooter.textContent).toBe('End')
      expect(originalBadge.textContent).toBe('ok')
      expect(host.querySelector('.after')?.textContent).toBe('7')

      const domBody = domCompiled.code.replace(/^import .*?;\n/gm, '').replace(/export function /, 'function ')
      const makeDom = new Function(
        '__template', '__loop', '__insert', '__show', '__effect', '__setText', '__firstText', '__textAfter', '__skipText', '__skipRange', 'items', 'show', 'count',
        `${domBody}\nreturn Panel({ items, show, count })`,
      )
      const dispose = domCore.hydrate(host, () => makeDom(
        domCore.template, domLoop.loop, domExtras.insert, domExtras.show, domCore.effect, domCore.setText, domCore.firstText, domCore.textAfter, domCore.skipText, domCore.skipRange,
        items, show, count,
      ))

      // Sibling footer & Badge nodes were preserved, and dynamic text in mixed ternary updates reactively!
      expect(host.querySelector('.footer')).toBe(originalFooter)
      expect(host.querySelector('b')).toBe(originalBadge)

      count.value = 42
      expect(host.querySelector('.after')?.textContent).toBe('42')

      show.value = true
      expect(host.querySelector('.after em')?.textContent).toBe('yes')

      items.value = ['A', 'B', 'C']
      expect([...host.querySelectorAll('li')].map(el => el.textContent)).toEqual(['A', 'B', 'C', 'End'])
      dispose()
    })
  })

  it('server-only guardrails catch Bun.env, bun, and node:crypto while respecting local shadowing', () => {
    expect(SERVER_ONLY_MODULES.has('bun')).toBe(true)
    expect(SERVER_ONLY_MODULES.has('node:crypto')).toBe(true)
    expect(SERVER_ONLY_MODULES.has('node:async_hooks')).toBe(true)

    const bunEnv = analyzeModule('a.ts', 'export const x = Bun.env.SECRET')
    expect(readsPrivateEnv(bunEnv.program)).toBe(true)

    const shadowed = analyzeModule('b.ts', 'export function f(process: { env: { X: string } }) { return process.env.X }')
    expect(readsPrivateEnv(shadowed.program)).toBe(false)
  })

  it('hardens server routes (405 on page POST, fastStaticPages locals, trailing-slash Router, CookieStore validation, static CSP & /%00)', async () => {
    // 1. Router normalizes trailing slash in add()
    const router = new Router<string>()
    router.add('/api/health/', 'ok')
    expect(router.match('/api/health')?.data).toBe('ok')

    // 2. CookieStore validation, dedup, and RFC 6265 first-wins
    const jar = new CookieStore('sid=first; sid=second')
    expect(jar.get('sid')).toBe('first')
    expect(() => jar.set('bad;name', '1')).toThrow()
    expect(() => jar.set('ok', '1', { path: '/; evil=1' })).toThrow()
    jar.set('token', 'one')
    jar.set('token', 'two')
    const headers = new Headers()
    jar.applyTo(headers)
    expect(headers.getSetCookie()).toHaveLength(1)
    expect(headers.getSetCookie()[0]).toContain('token=two')

    // 3. Page POST returns 405 with Allow header, and fastStaticPages preserves ctx.locals from load()
    const dir = makeTemp('kay-server-hardening-')
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      export function load(ctx: any) {
        ctx.locals.marker = 'from-load'
        return { ok: true }
      }
      export default function Home({ locals }: any) {
        return <p data-marker={locals.marker}>{locals.marker}</p>
      }
    `)
    await build({ root: dir })
    const app = await createServer({ root: dir })
    try {
      const getRes = await app.handle(new Request('http://localhost/'))
      expect(getRes.status).toBe(200)
      expect(await getRes.text()).toContain('from-load')

      const postRes = await app.handle(new Request('http://localhost/', { method: 'POST' }))
      expect(postRes.status).toBe(405)
      expect(postRes.headers.get('allow')).toContain('GET')
    }
    finally {
      await app.dispose?.()
    }

    // 4. Static export server sets KAY_ISLAND_STYLE_HASH in CSP and returns 404 (not 500) on /%00
    const staticDir = makeTemp('kay-static-hardening-')
    mkdirSync(join(staticDir, 'src/routes'), { recursive: true })
    writeFileSync(join(staticDir, 'src/routes/index.tsx'), `export default function Home() { return <p>hi</p> }\n`)
    await build({ root: staticDir, static: true })
    const staticApp = await createServer({ root: staticDir })
    try {
      const res = await staticApp.handle(new Request('http://localhost/'))
      expect(res.headers.get('content-security-policy')).toContain(KAY_ISLAND_STYLE_HASH)
      const nullByteRes = await staticApp.handle(new Request('http://localhost/%00'))
      expect(nullByteRes.status).toBe(404)
      const postStatic = await staticApp.handle(new Request('http://localhost/', { method: 'POST' }))
      expect(postStatic.status).toBe(405)
      expect(postStatic.headers.get('allow')).toBe('GET, HEAD')
    }
    finally {
      await staticApp.dispose?.()
    }
  })

  it('kay check skips _components dirs and catches interactive _layout.tsx', async () => {
    const dir = makeTemp('kay-check-unified-')
    mkdirSync(join(dir, 'src/routes/_components'), { recursive: true })
    writeFileSync(join(dir, 'src/routes/_components/Helper.tsx'), `export function Helper() { return <span>hi</span> }\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `import { Helper } from './_components/Helper'\nexport default function Home() { return <Helper /> }\n`)
    writeFileSync(join(dir, 'src/routes/_layout.tsx'), `import { signal } from '@kayjs/kay'\nexport default function Layout({ children }: any) { const n = signal(0); return <div>{n.value}{children}</div> }\n`)

    const res = await checkProject(dir, { skipTypecheck: true })
    expect(res.ok).toBe(false)
    expect(res.errors.some(e => e.includes('_layout.tsx') && e.includes('server only'))).toBe(true)
    expect(res.errors.some(e => e.includes('conflicting routes'))).toBe(false)
  })

  it('plugin-content sanitizer blocks &Tab;/&NewLine; XSS and style/data-persist; shareCard escapes SVG attrs', () => {
    const clean = sanitizeMarkdownHtml('<a href="java&Tab;script:alert(1)">x</a><a href="java&NewLine;script:alert(2)">y</a><div style="background:url(evil)" data-persist="p">ok</div>')
    expect(clean).not.toContain('javascript')
    expect(clean).not.toContain('java&Tab;')
    expect(clean).not.toContain('style=')
    expect(clean).not.toContain('data-persist=')

    const dir = makeTemp('kay-card-sec-')
    const cardUrl = shareCard({
      title: 'Hello',
      background: '#000" onload="alert(1)',
      image: '/etc/passwd',
    }, { publicDir: dir })
    expect(cardUrl).toStartWith('/og/hello-')
  })
})
