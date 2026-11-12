import { readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { importsBrowserOnly } from '../src/build/probe'
import { browserOnlyHint, mapStack } from '../src/build/sourcemap'
import { transformKayCached } from '../src/build/transform'
import { compileKay } from '../src/compiler'
import { parseKay } from '../src/compiler/parser'
import { analyzeScript } from '../src/compiler/script'
import { child } from '../src/runtime/html'
import { eventually } from './helpers/eventually'
import { scratchDir } from './scratch'

await plugin(kay())

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
  'skeleton.kay': '--- client\nconst { n } = props<{ n: number }>()\nconst width = window.innerWidth\n---\nb.real {n}:{width}\n@fallback\n  b.skeleton waiting\n',
  'boom.kay': '--- client\nimport { onCleanup } from \'kay\'\n\nconst log = (globalThis as { cleaned?: string[] }).cleaned ??= []\nonCleanup(() => log.push(\'cleaned\'))\n---\np.first first\nif true\n  b.second second\n  u {(() => { throw new Error(\'midway\') })()}\n@fallback\n  i.hold held\n',
  'avatar.kay': '--- client\nconst { fallback } = props<{ fallback: string }>()\nconst width = window.innerWidth\n---\nb.av {fallback}:{width}\n',
  'page.kay': '---\nimport Avatar from \'./avatar.kay\'\nimport Chart from \'./chart.kay\'\nimport Panel from \'./panel.kay\'\nimport Plain from \'./plain.kay\'\nimport Skeleton from \'./skeleton.kay\'\nimport Width from \'./width.kay\'\n---\nmain\n  Chart(label="sales")\n  Panel\n  Width(unit="em")\n  Plain(hydrate="client")\n  Plain(hydrate="client")\n    @fallback\n      i.hold held\n  Skeleton(n={2})\n  Skeleton(n={3})\n    @fallback\n      i.own mine\n  Avatar(fallback="hi")\n',
}

let dir: string
let html: string
let ids: Record<string, string>

beforeAll(async () => {
  dir = await scratchDir('dom-')
  await Promise.all(Object.entries(FILES).map(async ([name, text]) => Bun.write(join(dir, name), text)))
  ids = Object.fromEntries(['avatar', 'boom', 'chart', 'panel', 'plain', 'skeleton', 'width'].map(name => [name, relative(process.cwd(), join(dir, `${name}.kay`))]))

  const { default: Page } = await import(join(dir, 'page.kay')) as { default: () => unknown }

  html = child(Page())
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('client-only islands', () => {
  it('renders an island importing a package that cannot load without a DOM in the browser only, never loading the package on the server', () => {
    expect(html).toContain(`<slot data-component="${ids.chart}" data-props='[{"label":1},"sales"]' data-client></slot>`)
  })

  it('leaves the slot of a `--- client` component empty, and its part inside another island', () => {
    expect(html).toContain(`<slot data-component="${ids.width}" data-props='[{"unit":1},"em"]' data-client></slot>`)
    expect(html).toContain('<section><button class="toggle">0</button><!--[--><!--]--><p class="after">after</p></section>')
  })

  it('renders an island the browser only with `hydrate="client"`', () => {
    expect(html).toContain(`<slot data-component="${ids.plain}" data-props="[{}]" data-client></slot>`)
  })

  it('shows a fallback in the slot of a client-only use or component, the use\'s own block winning, without sending it as a prop', () => {
    expect(html).toContain(`<slot data-component="${ids.plain}" data-props="[{}]" data-client><i class="hold">held</i></slot>`)
    expect(html).toContain(`<slot data-component="${ids.skeleton}" data-props='[{"n":1},2]' data-client><b class="skeleton">waiting</b></slot>`)
    expect(html).toContain(`<slot data-component="${ids.skeleton}" data-props='[{"n":1},3]' data-client><i class="own">mine</i></slot>`)
  })

  it('keeps a client-only component\'s own `fallback` prop, which is not the block a use writes', () => {
    expect(html).toContain(`<slot data-component="${ids.avatar}" data-props='[{"fallback":1},"hi"]' data-client></slot>`)
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
      await eventually(() => expect(document.querySelector('button.chart')!.textContent).toBe(`sales ratio ${window.devicePixelRatio} 1`))

      const section = document.querySelector('section')!

      expect(section.querySelector('button')).toBe(toggle)
      expect([...section.children].map(element => element.outerHTML)).toEqual([toggle.outerHTML, `<span class="width"><!--[-->${window.innerWidth}<!--]--><!--[-->px<!--]--></span>`, '<p class="after">after</p>'])
      toggle.dispatchEvent(new Event('click', { bubbles: true }))
      await eventually(() => expect(toggle.textContent).toBe('1'))

      expect(document.querySelector(`slot[data-component="${ids.width}"]`)!.textContent).toBe(`${window.innerWidth}em`)
      expect(document.querySelector('b.plain')!.textContent).toBe('1')
      expect([...document.querySelectorAll('b.real')].map(element => element.textContent)).toEqual([`2:${window.innerWidth}`, `3:${window.innerWidth}`])
      expect(document.querySelector('.skeleton, .own, .hold')).toBeNull()
      expect(document.querySelector('b.av')!.textContent).toBe(`hi:${window.innerWidth}`)
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })

  it('keeps the fallback and no partial node of a client-only component that throws midway, disposing what it started', async () => {
    const entry = join(dir, 'boom-client.ts')

    await Bun.write(entry, `import { hydrateIslands } from 'kay/client'\n\nexport const ready = hydrateIslands({\n  ${JSON.stringify(ids.boom)}: () => import('./boom.kay'),\n})\n`)

    const build = await Bun.build({ entrypoints: [entry], outdir: join(dir, 'boom-out'), target: 'browser', splitting: true, plugins: [kay()] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    GlobalRegistrator.register()

    const errors: unknown[][] = []
    const original = console.error

    console.error = (...args: unknown[]) => void errors.push(args)

    try {
      document.body.innerHTML = `<slot data-component="${ids.boom}" data-props='[{}]' data-client><i class="hold">held</i></slot>`

      const { ready } = await import(join(dir, 'boom-out', 'boom-client.js')) as { ready: Promise<void> }

      await ready
      expect(document.querySelector('slot')!.innerHTML).toBe('<i class="hold">held</i>')
      expect(String(errors[0]?.[0] ?? '')).toContain('midway')
      expect((globalThis as { cleaned?: string[] }).cleaned).toEqual(['cleaned'])
    }
    finally {
      console.error = original
      await GlobalRegistrator.unregister()
    }
  })

  it('names the global, the .kay line reading it and both fixes when a server render fails on a browser-only global', async () => {
    const { default: Bad } = await import(join(dir, 'bad.kay')) as { default: (props: { unit: string }) => unknown }
    const error = (() => {
      try {
        child(Bad({ unit: 'px' }))

        return undefined
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

describe('the fallback of a client-only component', () => {
  const root = join(process.cwd(), 'tests/fixtures/static')
  const compile = (source: string) => compileKay(source, join(root, 'src/widget.kay'), { output: 'html', component: true, root })

  it('keeps its shorthand classes and the scope attribute of the component\'s styles', () => {
    const compiled = compile('--- client\nconst w = window.innerWidth\n---\n--- style\n.map { color: red }\n---\np.real {w}\n@fallback\n  .map.animate-pulse\n')

    expect(compiled.classes).toContain('animate-pulse')
    expect(compiled.tsx).toContain('function KayFallback(')
    expect(compiled.tsx).toMatch(/data-k-\w+ class=\\+"map animate-pulse\\+"/)
  })

  it('copies the imports it names, and reports a script value or prop it reads', () => {
    const compiled = compile('--- client\nimport Icon from \'./icon.kay\'\nimport Other from \'./other.kay\'\nconst { n } = props<{ n: number }>()\nconst width = window.innerWidth\n---\np.real {n}\n@fallback\n  Icon\n  b {width}\n  i {n}\n  u {Math.max(1, 2)}\n')

    expect(compiled.tsx).toContain('import Icon from')
    expect(compiled.tsx).not.toContain('import Other from')
    expect(compiled.tsx.indexOf('import Icon from')).toBeLessThan(compiled.tsx.indexOf('function KayFallback('))
    expect(compiled.diagnostics.map(diagnostic => diagnostic.message)).toEqual([
      '`@fallback` of a `--- client` component reads `width`, which the server does not have',
      '`@fallback` of a `--- client` component reads `n`, which the server does not have',
    ])
  })

  it('reads the script\'s declarations from the parsed script: each name of a list, a default in a pattern', () => {
    const reported = (script: string, fallback: string) => compile(`--- client\n${script}\n---\np.real\n@fallback\n  ${fallback}\n`).diagnostics.map(diagnostic => diagnostic.message.match(/reads `(\w+)`/)?.[1])

    expect(reported('const a = 1, b = 2', 'b {b}')).toEqual(['b'])
    expect(reported('const { a = 1 } = props<{ a?: number }>()', 'b {a}')).toEqual(['a'])
    expect(reported('const [x, , y = 3, ...rest] = [1]', 'b {rest.length}')).toEqual(['rest'])
    expect(reported('function helper() {}\nclass Thing {}', 'b {helper()}{Thing}')).toEqual(['helper', 'Thing'])
  })

  it('reports no read of a name that is not the script\'s, a const inside a script function, a template binder or an object key', () => {
    const reported = (script: string, fallback: string) => compile(`--- client\n${script}\n---\np.real\n@fallback\n  ${fallback}\n`).diagnostics.map(diagnostic => diagnostic.message)

    expect(reported('function run() { const inner = 1 }', 'b {inner}')).toEqual([])
    expect(reported('const item = 1', 'for item of [1, 2]\n    i {item}')).toEqual([])
    expect(reported('const width = 1', 'b {JSON.stringify({ width: 2 })}')).toEqual([])
    expect(reported('const width = 1', 'b {[1].map(width => width)}')).toEqual([])
    expect(reported('const width = 1', 'const width = 2\n  b {width}')).toEqual([])
    expect(reported('const width = 1', 'b {Math.max.width}')).toEqual([])
    expect(reported('const width = 1', 'b {width}')).toHaveLength(1)
    expect(reported('const width = 1', 'b {(function width() { return 1 })()}')).toEqual([])
    expect(reported('const width = 1', 'b {[1].map((n) => { const width = n; return width })}')).toEqual([])
  })

  it('reports a script name read as a shorthand, a spread, a template part, a chain or beside a shadowing parameter, and an enum declared by the script', () => {
    const reported = (script: string, fallback: string) => compile(`--- client\n${script}\n---\np.real\n@fallback\n  ${fallback}\n`).diagnostics.map(diagnostic => diagnostic.message.match(/reads `(\w+)`/)?.[1])

    expect(reported('const width = 1', 'b {JSON.stringify({ width })}')).toEqual(['width'])
    expect(reported('const rest = {}', 'b({...rest})')).toEqual(['rest'])
    expect(reported('const rest = {}', 'b {JSON.stringify({ ...rest })}')).toEqual(['rest'])
    expect(reported('const width = 1', 'b {`w${width}`}')).toEqual(['width'])
    expect(reported('const width = {} as { x?: number }', 'b {width?.x}')).toEqual(['width'])
    expect(reported('const width = 1', 'b {width + [1].map(width => width).length}')).toEqual(['width'])
    expect(reported('enum Mode { A }', 'b {Mode.A}')).toEqual(['Mode'])
  })

  it('compiles an empty block', () => {
    const compiled = compile('--- client\nconst w = window.innerWidth\n---\np.real {w}\n@fallback\n')

    expect(compiled.diagnostics).toEqual([])
    expect(compiled.tsx).toContain('function KayFallback(')
  })
})

describe('client-only islands through the cache', () => {
  it('keeps the packages to probe beside the compiled file, so a compile found in the cache parses nothing to ask', async () => {
    const cacheDir = join(dir, 'probed-cache')
    const file = join(dir, 'chart.kay')
    const options = { target: 'ssr', hydratable: true, root: dir, cacheDir } as const
    const first = await transformKayCached(FILES['chart.kay']!, file, options)
    const probed = (await readdir(cacheDir)).filter(name => name.endsWith('-probed.json'))

    expect(first).toContain('KayIsland(')
    expect(probed).toHaveLength(1)

    // The entry is what the second call reads, so one only the entry can answer shows it is read.
    const entry = join(cacheDir, probed[0]!)
    const kept = await Bun.file(entry).json() as { key: string, value: string[] }

    expect(kept.value).toEqual(['dom-only'])
    await Bun.write(entry, JSON.stringify({ ...kept, value: [] }))
    expect(await transformKayCached(FILES['chart.kay']!, file, options)).not.toBe(first)

    // A source that changes replaces it, and a component that is no island probes nothing.
    await transformKayCached('---\nimport { describe } from \'dom-only\'\n---\np {describe()}\n', file, options)
    expect((await Bun.file(entry).json() as { value: string[] }).value).toEqual([])
    expect(await transformKayCached(FILES['chart.kay']!, file, options)).toBe(first)
  })
})

describe('browser-only globals read while rendering', () => {
  // Each fix as the source it leaves, its edits applied from the last.
  const fixed = (source: string, edits: { start: number, end: number, text: string }[]) => edits.toSorted((a, b) => b.start - a.start).reduce((text, change) => text.slice(0, change.start) + change.text + text.slice(change.end), source)
  const reads = (source: string) => compileKay(source, join(process.cwd(), 'widget.kay'), { check: true, lints: { 'constant-signal': 'allow' } }).diagnostics.map(diagnostic => ({ text: source.slice(diagnostic.start, diagnostic.end), message: diagnostic.message, fixes: diagnostic.fixes?.map(fix => fixed(source, fix.edits)) }))
  const client = (source: string) => source.replace('---', '--- client')

  it('reports one read by the script, a function the template calls, a memo or the template itself, each with its fixes', () => {
    const source = '---\nimport { memo, signal } from \'kay\'\n\nconst width = signal(window.innerWidth)\nlocalStorage.setItem(\'seen\', \'1\')\nconst title = () => document.title\nconst ratio = memo(() => devicePixelRatio)\n---\np {title()} {ratio()} {width()}\nfor item of [1] key={item}\n  span {sessionStorage.length}\n'

    expect(reads(source)).toEqual([
      { text: 'window', message: '`window` exists only in the browser', fixes: [client(source)] },
      { text: 'localStorage', message: '`localStorage` exists only in the browser', fixes: [source.replace('localStorage.setItem(\'seen\', \'1\')', 'effect(() => localStorage.setItem(\'seen\', \'1\'))').replace('memo, signal', 'memo, signal, effect'), client(source)] },
      { text: 'document', message: '`document` exists only in the browser', fixes: [client(source)] },
      { text: 'devicePixelRatio', message: '`devicePixelRatio` exists only in the browser', fixes: [client(source)] },
      { text: 'sessionStorage', message: '`sessionStorage` exists only in the browser', fixes: [client(source)] },
    ])
  })

  it('marks the `effect` wrap safe only for a statement that is a call on the global or an assignment to a member of it', () => {
    const safe = (statement: string) => compileKay(`---\nlet seen = 0\nconst later = () => 1\n${statement}\n---\np {seen} {later()}\n`, join(process.cwd(), 'widget.kay'), { check: true }).diagnostics.flatMap(diagnostic => diagnostic.fixes ?? []).filter(fix => fix.title.startsWith('Read')).map(fix => fix.safe === true)

    expect(safe('localStorage.setItem(\'seen\', \'1\')')).toEqual([true])
    expect(safe('document.title = \'Home\'')).toEqual([true])
    expect(safe('document.body.classList.add(\'js\')')).toEqual([true])
    expect(safe('window.matchMedia(\'(min-width: 1px)\')?.addEventListener(\'change\', later)')).toEqual([true])
    // A local the rest of the script reads, a function of the script, an awaited value and a read in a declaration's value are offered, never applied unasked.
    expect(safe('seen = window.innerWidth')).toEqual([false])
    expect(safe('later(window.innerWidth)')).toEqual([false])
    expect(safe('await window.fetchLater()')).toEqual([false])
    expect(safe('const width = window.innerWidth')).toEqual([])
  })

  it('brings `effect` in with the wrap, once, and not when the script has it', () => {
    expect(reads('---\nlocalStorage.clear()\n---\np x\n')[0]!.fixes![0]).toBe('---\nimport { effect } from \'kay\'\n\neffect(() => localStorage.clear())\n---\np x\n')
    expect(reads('---\nimport { effect } from \'kay\'\n\nlocalStorage.clear()\n---\np x\n')[0]!.fixes![0]).toBe('---\nimport { effect } from \'kay\'\n\neffect(() => localStorage.clear())\n---\np x\n')
  })

  it('follows a read through functions nested several levels, only while each one runs as the component renders', () => {
    const source = '---\nimport { memo } from \'kay\'\n\nconst a = () => (() => (() => document.title)())()\nconst b = () => memo(() => (() => window.name)())\nconst c = () => () => () => localStorage.length\nconst d = () => { const inner = () => sessionStorage.length; return inner }\n---\np {a()} {b()} {c()} {d()}\n'

    expect(reads(source).map(read => read.text)).toEqual(['document', 'window'])
  })

  it('reads a decorator while the class is defined, but not the body of what it decorates', () => {
    const source = '---\nfunction dec(value: unknown) { return (target: unknown) => target }\n\nclass Box {\n  @dec(document.title)\n  method() { return window.name }\n}\n---\np {new Box().method.name}\n'

    expect(reads(source).map(read => read.text)).toEqual(['document'])
  })

  it('turns a `--- script` fence into `--- client`', () => {
    const source = '--- script\nconst title = document.title\n---\np {title}\n'

    expect(reads(source)).toEqual([{ text: 'document', message: '`document` exists only in the browser', fixes: [source.replace('--- script', '--- client')] }])
  })

  it('leaves handlers, refs, effects and other callbacks alone, as globals Bun has, shadowed names and types', () => {
    const source = '---\nimport { effect, onMount } from \'kay\'\n\nconst location = \'here\'\nconst later = () => alert(\'later\')\neffect(() => console.log(localStorage.length))\nonMount(() => document.body.focus())\nsetTimeout(() => window.scrollTo(0, 0))\nconst at: Window | undefined = undefined\nconst socket = typeof WebSocket\n---\nbutton(onClick={later} ref={() => window.focus()}) {location} {fetch.name} {URL.name} {crypto.randomUUID()} {String(at)} {socket}\n'

    expect(reads(source)).toEqual([])
    expect(reads('---\nconst a = globalThis.window?.name\nconst b = typeof globalThis.document !== \'undefined\' ? globalThis.document.title : \'\'\n---\np {a} {b}\n')).toEqual([])
    expect(reads('---\nconst title = globalThis.document.title\n---\np {title}\n').map(read => read.text)).toEqual(['document'])
    expect(reads('--- server\nconst status = \'ok\'\n---\np {status}\nfor event of [status] key={event}\n  span {event}\n')).toEqual([])
  })

  it('leaves the target of `listen` alone, which the compiler hands over as a function the server never calls', () => {
    const source = '---\nimport { listen, signal } from \'kay\'\n\nconst key = signal(\'\')\nlisten(window, \'keydown\', event => key = event.key)\nlisten(window.visualViewport!, \'resize\', () => key = \'\')\n---\np {key()}\n'
    const compiled = (output: 'dom' | 'html') => compileKay(source, join(process.cwd(), 'widget.kay'), { output, hydratable: true }).tsx

    expect(reads(source)).toEqual([])
    expect(reads(source.replace('listen(window,', 'listen(document.title.length ? window : window,'))).toEqual([])
    expect(reads(source.replace('listen(window,', 'listen(window[localStorage.key(0)!] as Window, document.title,')).map(read => read.text)).toEqual(['document'])

    expect(reads(source.replace('listen(window,', 'listen(document,'))).toEqual([])
    expect(reads(source.replace('listen(window,', 'listen(document.body,'))).toEqual([])
    expect(reads(source.replace('listen(window,', 'listen(document.documentElement,'))).toEqual([])
    expect(reads(source.replace('listen(window,', 'listen(() => document,'))).toEqual([])

    for (const output of ['dom', 'html'] as const) {
      expect(compiled(output)).toContain('listen(() => (window), \'keydown\'')
      expect(compiled(output)).toContain('listen(() => (window.visualViewport!), \'resize\'')
    }
  })

  it('reports `typeof window` while an island renders as a hydration mismatch, but not in a static component', () => {
    const island = '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\nconst server = typeof window === \'undefined\'\n---\nbutton(onClick={() => count.set(c => c + 1)}) {server ? \'server\' : count()}\n'
    const page = '---\nconst server = typeof window === \'undefined\'\n---\np {server}\n'

    expect(reads(island)).toEqual([{ text: 'window', message: '`typeof window` differs between the server and the browser', fixes: [client(island)] }])
    expect(reads(page)).toEqual([])
    expect(compileKay(island, join(process.cwd(), 'widget.kay'), { check: true }).diagnostics.map(diagnostic => [diagnostic.note, diagnostic.help])).toEqual([['what the island renders from it will not match the server\'s markup when it hydrates', 'read it in `effect` or `onMount`, or render the component in the browser only with `--- client`']])
  })

  it('refuses `--- client` on a layout or a page with a server fence', () => {
    expect(compileKay('--- client\n---\nslot\n', join(process.cwd(), '_layout.kay')).diagnostics.map(diagnostic => [diagnostic.message, diagnostic.note])).toEqual([['A page, layout or special page cannot be `--- client`', 'it renders on the server']])
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

describe('values an island renders differently on the server and in the browser', () => {
  const reads = (source: string) => compileKay(source, join(process.cwd(), 'widget.kay'), { check: true }).diagnostics.map(diagnostic => [source.slice(diagnostic.start, diagnostic.end), diagnostic.message])
  const island = (script: string, template: string) => `---\nimport { signal } from 'kay'\n\nconst count = signal(0)\n${script}\n---\nbutton(onClick={() => count.set(c => c + 1)}) ${template}\n`

  it('reports the clock, a random number, and a locale or time zone left to the platform while an island renders', () => {
    const source = island('const now = Date.now()\nconst at = new Date()\nconst pick = Math.random()\nconst price = (1234.5).toLocaleString()\nconst day = at.toLocaleDateString(\'fr\')\nconst money = new Intl.NumberFormat().format(2)\nconst time = new Intl.DateTimeFormat(\'fr\', { hour: \'numeric\' })', '{now} {pick} {price} {day} {money} {time.format(at)} {count()} {Date()}')

    expect(reads(source)).toEqual([
      ['Date.now()', '`Date.now()` reads the clock, which has moved on by the time the island hydrates'],
      ['new Date()', '`new Date()` reads the clock, which has moved on by the time the island hydrates'],
      ['Math.random()', '`Math.random()` gives another number in the browser'],
      ['(1234.5).toLocaleString()', '`toLocaleString()` formats in the server\'s default locale there and in the visitor\'s in the browser'],
      ['at.toLocaleDateString(\'fr\')', '`toLocaleDateString()` formats in the server\'s time zone there and in the visitor\'s in the browser'],
      ['new Intl.NumberFormat()', '`Intl.NumberFormat` formats in the server\'s default locale there and in the visitor\'s in the browser'],
      ['new Intl.DateTimeFormat(\'fr\', { hour: \'numeric\' })', '`Intl.DateTimeFormat` formats in the server\'s time zone there and in the visitor\'s in the browser'],
      ['Date()', '`Date()` reads the clock, which has moved on by the time the island hydrates'],
    ])
    expect(compileKay(island('const now = Date.now()', '{now}'), join(process.cwd(), 'widget.kay'), { check: true }).diagnostics.map(diagnostic => [diagnostic.message, diagnostic.note, diagnostic.help])).toEqual([['`Date.now()` reads the clock, which has moved on by the time the island hydrates', 'what the island renders from it will not match the server\'s markup when it hydrates', 'read it in `effect` or `onMount`, or on the server and pass it as a prop, or allow a deliberate read with `// kay-allow hydration-mismatch`']])
  })

  it('is the hydration-mismatch lint, which a kay-allow comment and the lint level reach', () => {
    const compile = (source: string, lints?: Record<string, 'allow' | 'warn'>) => compileKay(source, join(process.cwd(), 'widget.kay'), { check: true, lints }).diagnostics.map(diagnostic => [diagnostic.code, diagnostic.severity])
    const year = island('const stamp = new Date().getFullYear()', '{stamp}')
    const allowed = island('// kay-allow hydration-mismatch\nconst stamp = new Date().getFullYear()', '{stamp}')
    const file = island('const stamp = new Date().getFullYear()', '{stamp}').replace('---\n', '---\n// kay-allow-file hydration-mismatch\n')

    expect(compile(year)).toEqual([['hydration-mismatch', 'error']])
    expect(compile(allowed)).toEqual([])
    expect(compile(file)).toEqual([])
    expect(compile(year, { 'hydration-mismatch': 'warn' })).toEqual([['hydration-mismatch', 'warning']])
    expect(compile(year, { 'hydration-mismatch': 'allow' })).toEqual([])
    expect(compile(year, { islands: 'warn' })).toEqual([['hydration-mismatch', 'warning']])
    expect(compile(year, { islands: 'allow' })).toEqual([])
  })

  it('leaves alone what both sides compute alike, what runs in the browser only, and a static component', () => {
    const alike = island('const at = new Date(0)\nconst price = (2).toLocaleString(\'fr\')\nconst day = at.toLocaleDateString(\'fr\', { timeZone: \'UTC\' })\nconst time = new Intl.DateTimeFormat(\'fr\', { timeZone: \'Europe/Paris\' })\nconst options = { timeZone: \'UTC\' }\nconst hour = at.toLocaleTimeString(\'fr\', options)\nconst Date = { now: () => 1 }', '{price} {day} {time.format(at)} {hour} {Date.now()} {count()}')
    const later = '---\nimport { effect, signal } from \'kay\'\n\nconst count = signal(0)\neffect(() => count = Date.now())\n---\nbutton(onClick={() => count = Math.random()}) {count()}\n'

    expect(reads(alike)).toEqual([])
    expect(reads(later)).toEqual([])
    expect(reads('---\nconst now = Date.now()\n---\np {now}\n')).toEqual([])
  })
})
