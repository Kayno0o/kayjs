import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { importsBrowserOnly } from '../src/build/probe'
import { browserOnlyHint, mapStack } from '../src/build/sourcemap'
import { compileKay } from '../src/compiler'
import { parseKay } from '../src/compiler/parser'
import { analyzeScript } from '../src/compiler/script'
import { child } from '../src/runtime/html'

plugin(kay())

// A package touching `window` as it loads, as CodeMirror or hls.js do.
const DOM_ONLY = {
  'node_modules/dom-only/package.json': JSON.stringify({ name: 'dom-only', version: '1.2.3', type: 'module', main: 'index.js' }),
  'node_modules/dom-only/index.js': 'const ratio = window.devicePixelRatio\n\nexport function describe() {\n  return `ratio ${ratio}`\n}\n',
}

const FILES: Record<string, string> = {
  ...DOM_ONLY,
  'chart.kay': '---\nimport { describe } from \'dom-only\'\nimport { signal } from \'kay\'\n\nconst { label } = props<{ label: string }>()\nconst clicks = signal(0)\n---\nbutton.chart(onClick={() => clicks.set(c => c + 1)}) {label} {describe()} {clicks()}\n',
  'width.kay': '--- client\nconst { unit } = props<{ unit: string }>()\nconst width = window.innerWidth\n---\nspan.width {width}{unit}\n',
  'panel.kay': '---\nimport { signal } from \'kay\'\nimport Width from \'./width.kay\'\n\nconst open = signal(0)\n---\nsection\n  button.toggle(onClick={() => open.set(o => o + 1)}) {open()}\n  Width(unit="px")\n  p.after after\n',
  'bad.kay': '---\nconst { unit } = props<{ unit: string }>()\nconst width = window.innerWidth\n---\np {width}{unit}\n',
  'plain.kay': '---\nimport { signal } from \'kay\'\n\nconst n = signal(1)\n---\nb.plain {n()}\n',
  'page.kay': '---\nimport Chart from \'./chart.kay\'\nimport Panel from \'./panel.kay\'\nimport Plain from \'./plain.kay\'\nimport Width from \'./width.kay\'\n---\nmain\n  Chart(label="sales")\n  Panel\n  Width(unit="em")\n  Plain(hydrate="client")\n',
}

let dir: string
let html: string
let ids: Record<string, string>

beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, '.dom-'))
  await Promise.all(Object.entries(FILES).map(async ([name, text]) => Bun.write(join(dir, name), text)))
  ids = Object.fromEntries(['chart', 'panel', 'plain', 'width'].map(name => [name, relative(process.cwd(), join(dir, `${name}.kay`))]))

  const { default: Page } = await import(join(dir, 'page.kay')) as { default: () => unknown }

  html = child(Page())
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('client-only islands', () => {
  it('renders an island importing a package that cannot load without a DOM in the browser only, never loading the package on the server', () => {
    expect(html).toContain(`<slot data-component="${ids.chart}" data-props="[{&quot;label&quot;:1},&quot;sales&quot;]" data-client></slot>`)
  })

  it('leaves the slot of a `--- client` component empty, and its part inside another island', () => {
    expect(html).toContain(`<slot data-component="${ids.width}" data-props="[{&quot;unit&quot;:1},&quot;em&quot;]" data-client></slot>`)
    expect(html).toContain('<section><button class="toggle">0</button><!--[--><!--]--><p class="after">after</p></section>')
  })

  it('renders an island the browser only with `hydrate="client"`', () => {
    expect(html).toContain(`<slot data-component="${ids.plain}" data-props="[{}]" data-client></slot>`)
  })

  it('renders each one in the browser, the nested one where the server left its part, and hydrates the rest', async () => {
    const entry = join(dir, 'client.ts')

    await Bun.write(entry, `import { hydrateIslands } from 'kay/client'\n\nexport const ready = hydrateIslands({\n${Object.entries(ids).map(([name, id]) => `  ${JSON.stringify(id)}: () => import('./${name}.kay'),`).join('\n')}\n})\n`)

    const build = await Bun.build({ entrypoints: [entry], outdir: join(dir, 'out'), target: 'browser', splitting: true, plugins: [kay()] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    GlobalRegistrator.register()

    try {
      document.body.innerHTML = html

      const toggle = document.querySelector('button')!
      const { ready } = await import(join(dir, 'out', 'client.js')) as { ready: Promise<void> }

      await ready
      expect(document.querySelector('button.chart')!.textContent).toBe(`sales ratio ${window.devicePixelRatio} 0`)
      document.querySelector('button.chart')!.dispatchEvent(new Event('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(document.querySelector('button.chart')!.textContent).toBe(`sales ratio ${window.devicePixelRatio} 1`)

      const section = document.querySelector('section')!

      expect(section.querySelector('button')).toBe(toggle)
      expect([...section.children].map(element => element.outerHTML)).toEqual([toggle.outerHTML, `<span class="width"><!--[-->${window.innerWidth}<!--]--><!--[-->px<!--]--></span>`, '<p class="after">after</p>'])
      toggle.dispatchEvent(new Event('click', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(toggle.textContent).toBe('1')

      expect(document.querySelector(`slot[data-component="${ids.width}"]`)!.textContent).toBe(`${window.innerWidth}em`)
      expect(document.querySelector('b.plain')!.textContent).toBe('1')
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('names the global, the .kay line reading it and both fixes when a server render fails on a browser-only global', async () => {
    const { default: Bad } = await import(join(dir, 'bad.kay')) as { default: (props: { unit: string }) => unknown }
    const error = (() => {
      try {
        child(Bad({ unit: 'px' }))
      }
      catch (thrown) {
        return thrown as Error
      }
    })()

    expect(browserOnlyHint(error, mapStack(error!.stack!))).toBe(`\`window\` exists only in the browser, and rendering ${relative(process.cwd(), join(dir, 'bad.kay'))}:3:15 on the server read it: read it in \`effect\` or \`onMount\`, or render the component in the browser only with \`--- client\``)
    expect(browserOnlyHint(new ReferenceError('missing is not defined'), '')).toBeUndefined()
  })

  it('probes a package once per version, keeping the answer in the cache', async () => {
    const cacheDir = join(dir, 'cache')
    const source = FILES['chart.kay']!
    const script = analyzeScript(source, parseKay(source).script)
    const loadable = '---\nimport { stringify } from \'devalue\'\nimport type { Window } from \'happy-dom\'\n---\np x\n'

    expect(await importsBrowserOnly(source, script, join(dir, 'chart.kay'), cacheDir)).toBe(true)
    expect(await importsBrowserOnly(loadable, analyzeScript(loadable, parseKay(loadable).script), join(dir, 'chart.kay'), cacheDir)).toBe(false)
    expect((await readdir(cacheDir)).filter(name => name.endsWith('-browser-only.json'))).toHaveLength(2)

    // A package leaving a timer running, and printing as it loads, answers at once all the same.
    const lingering = join(dir, 'node_modules/lingering')

    await Bun.write(join(lingering, 'package.json'), JSON.stringify({ name: 'lingering', version: '1.0.0', type: 'module', main: 'index.js' }))
    await Bun.write(join(lingering, 'index.js'), 'console.log(\'["ReferenceError","window is not defined"]\')\nsetInterval(() => {}, 1000)\nexport const x = 1\n')

    const started = performance.now()
    const holding = '---\nimport { x } from \'lingering\'\n---\np {x}\n'

    expect(await importsBrowserOnly(holding, analyzeScript(holding, parseKay(holding).script), join(dir, 'chart.kay'), cacheDir)).toBe(false)
    expect(performance.now() - started).toBeLessThan(5000)
  })
})

describe('browser-only globals read while rendering', () => {
  // Each fix as the source it leaves, its edits applied from the last.
  const fixed = (source: string, edits: { start: number, end: number, text: string }[]) => edits.toSorted((a, b) => b.start - a.start).reduce((text, change) => text.slice(0, change.start) + change.text + text.slice(change.end), source)
  const reads = (source: string) => compileKay(source, join(process.cwd(), 'widget.kay'), { check: true }).diagnostics.map(diagnostic => ({ text: source.slice(diagnostic.start, diagnostic.end), message: diagnostic.message.slice(0, diagnostic.message.indexOf(',')), fixes: diagnostic.fixes?.map(fix => fixed(source, fix.edits)) }))
  const client = (source: string) => source.replace('---', '--- client')

  it('reports one read by the script, a function the template calls, a memo or the template itself, each with its fixes', () => {
    const source = '---\nimport { memo, signal } from \'kay\'\n\nconst width = signal(window.innerWidth)\nlocalStorage.setItem(\'seen\', \'1\')\nconst title = () => document.title\nconst ratio = memo(() => devicePixelRatio)\n---\np {title()} {ratio()} {width()}\nfor item of [1] key={item}\n  span {sessionStorage.length}\n'

    expect(reads(source)).toEqual([
      { text: 'window', message: '`window` exists only in the browser', fixes: [client(source)] },
      { text: 'localStorage', message: '`localStorage` exists only in the browser', fixes: [source.replace('memo, signal', 'memo, signal, effect').replace('localStorage.setItem(\'seen\', \'1\')', 'effect(() => localStorage.setItem(\'seen\', \'1\'))'), client(source)] },
      { text: 'document', message: '`document` exists only in the browser', fixes: [client(source)] },
      { text: 'devicePixelRatio', message: '`devicePixelRatio` exists only in the browser', fixes: [client(source)] },
      { text: 'sessionStorage', message: '`sessionStorage` exists only in the browser', fixes: [client(source)] },
    ])
  })

  it('leaves handlers, refs, effects and other callbacks alone, as globals Bun has, shadowed names and types', () => {
    const source = '---\nimport { effect, onMount } from \'kay\'\n\nconst location = \'here\'\nconst later = () => alert(\'later\')\neffect(() => console.log(localStorage.length))\nonMount(() => document.body.focus())\nsetTimeout(() => window.scrollTo(0, 0))\nconst at: Window | undefined = undefined\nconst socket = typeof WebSocket\n---\nbutton(onClick={later} ref={() => window.focus()}) {location} {fetch.name} {URL.name} {crypto.randomUUID()} {String(at)} {socket}\n'

    expect(reads(source)).toEqual([])
    expect(reads('--- server\nconst status = \'ok\'\n---\np {status}\nfor event of [status] key={event}\n  span {event}\n')).toEqual([])
  })

  it('reports `typeof window` while an island renders as a hydration mismatch, but not in a static component', () => {
    const island = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nconst server = typeof window === \'undefined\'\n---\nbutton(onClick={() => count.set(c => c + 1)}) {server ? \'server\' : count()}\n'
    const page = '---\nconst server = typeof window === \'undefined\'\n---\np {server}\n'

    expect(reads(island)).toEqual([{ text: 'window', message: '`typeof window` differs between the server and the browser', fixes: [client(island)] }])
    expect(reads(page)).toEqual([])
  })

  it('refuses `--- client` on a layout or a page with a server fence', () => {
    expect(compileKay('--- client\n---\nslot\n', join(process.cwd(), '_layout.kay')).diagnostics.map(diagnostic => diagnostic.message)).toEqual(['A page, layout or special page renders on the server; only a component it renders can be `--- client`'])
    expect(compileKay('--- server\nconst a = 1\n---\n--- client\n---\np {a}\n', join(process.cwd(), 'page.kay')).diagnostics).toHaveLength(1)
  })

  it('reads past names the template binds over the script\'s, and leaves guarded reads alone', () => {
    const clash = '---\nimport { signal } from \'kay\'\n\nconst item = 1\nconst name = signal(\'a\')\nfunction x() {}\n---\nfor item of [item] key={item}\n  for x of [name()] key={x}\n    span {x} {item} {innerHeight}\n'
    const guards = '---\nconst width = typeof window === \'undefined\' ? 0 : window.innerWidth\nlet saved = \'\'\n\nif (typeof localStorage !== \'undefined\')\n  saved = localStorage.getItem(\'x\') ?? \'\'\n\ntry {\n  saved = sessionStorage.getItem(\'y\') ?? saved\n}\ncatch {}\nconst ready = typeof document !== \'undefined\' && document.readyState\n---\np {width} {saved} {String(ready)}\n'

    expect(reads(clash).map(read => read.text)).toEqual(['innerHeight'])
    expect(reads(guards)).toEqual([])
  })

  it('offers no `--- client` on a layout or special page, nor switches one for a package it imports', () => {
    const layout = compileKay('---\nconst title = document.title\n---\nh1 {title}\nslot\n', join(process.cwd(), '_layout.kay'), { check: true })
    const page = compileKay('--- server\nconst a = 1\n---\n---\nimport { signal } from \'kay\'\n\nconst n = signal(a)\n---\nbutton(onClick={() => n.set(v => v + 1)}) {n()}\n', join(process.cwd(), 'page.kay'), { output: 'html', includeServer: true, hydratable: true, clientOnly: true })

    expect(layout.diagnostics.map(diagnostic => diagnostic.fixes)).toEqual([[]])
    expect(page.tsx).toContain('export async function load')
    expect(page.tsx).not.toContain('undefined, [], true')
  })

  it('adds a script fence to a component without one, and reports nothing in a `--- client` one', () => {
    expect(reads('p {window.location.href}\n')).toEqual([{ text: 'window', message: '`window` exists only in the browser', fixes: ['--- client\n---\np {window.location.href}\n'] }])
    expect(reads('--- client\nconst width = window.innerWidth\n---\np {width}\n')).toEqual([])
  })
})
