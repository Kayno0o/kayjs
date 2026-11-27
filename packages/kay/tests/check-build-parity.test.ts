import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'

const tempDirs: string[] = []
function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const repoRoot = join(import.meta.dir, '../../..')
function linkKay(dir: string): void {
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/@kayjs/kay'))
}

function appWith(prefix: string, files: Record<string, string>): string {
  const dir = makeTemp(prefix)
  linkKay(dir)
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('kay check and kay build graph/route parity (#3567)', () => {
  it('agrees on _-prefixed subdirs, _-prefixed helpers, action files, a default re-exported by name, and barrel re-exports', async () => {
    const dir = makeTemp('kay-parity-ok-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes/_components'), { recursive: true })
    mkdirSync(join(dir, 'src/ui'), { recursive: true })

    // _-prefixed subdir inside routes/: must NOT be treated as a route by either build or check
    writeFileSync(join(dir, 'src/routes/_components/Badge.tsx'), `
      export function Badge({ label }: { label: string }) {
        return <span>{label}</span>
      }
    `)

    writeFileSync(join(dir, 'src/routes/_helpers.ts'), `
      export function shout(s: string): string { return s.toUpperCase() }
    `)
    // An action file stays under routes/ so its folder's middleware guards it.
    writeFileSync(join(dir, 'src/routes/actions.ts'), `
      import { action } from '@kayjs/kay/server'
      export const ping = action(async () => 'pong')
    `)
    writeFileSync(join(dir, 'src/routes/_middleware.ts'), `
      import type { Middleware } from '@kayjs/kay/server'
      const pass: Middleware = (ctx, next) => next()
      export { pass as default }
    `)

    // Barrel re-exporting an interactive island
    writeFileSync(join(dir, 'src/ui/Counter.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Counter({ start }: { start: number }) {
        const n = signal(start)
        return <button onClick={() => n.value++}>{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/ui/index.ts'), `export { Counter } from './Counter'\n`)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Badge } from './_components/Badge'
      import { shout } from './_helpers'
      import { Counter } from '../ui'

      export default function Home() {
        return <main><Badge label={shout('ok')} /><Counter start={1} /></main>
      }
    `)

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.ok).toBe(true)
    expect(checked.errors).toEqual([])

    const manifest = await build({ root: dir, minify: false })
    expect(manifest.routes.map(r => r.path)).toEqual(['/'])
    expect(Object.keys(manifest.islands).length).toBe(1)
  })

  it('fails on a file under routes that exports no route, naming the fix (#3583)', async () => {
    const dir = appWith('kay-parity-no-route-', {
      'src/routes/helpers.ts': 'export function shout(s: string): string { return s.toUpperCase() }\n',
      'src/routes/index.tsx': 'export default function Home() { return <p>Home</p> }\n',
    })
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual(['src/routes/helpers.ts:1:1: error: kay check: src/routes/helpers.ts exports no route; move it out of src/routes or prefix it with _.'])
    await expect(build({ root: dir, minify: false })).rejects.toThrow('kay build: src/routes/helpers.ts exports no route; move it out of src/routes or prefix it with _.')
  })

  it('fails on a _layout, _middleware, _error or _404 with no default export (#3583)', async () => {
    const dir = appWith('kay-parity-no-default-', {
      'src/routes/_layout.tsx': 'export function Layout({ children }: { children?: unknown }) { return <main>{children}</main> }\n',
      'src/routes/admin/_middleware.ts': 'import type { Middleware } from \'@kayjs/kay/server\'\nexport const middleware: Middleware = (ctx, next) => next()\n',
      'src/routes/_error.tsx': 'export function ErrorPage() { return <p>Error</p> }\n',
      'src/routes/_404.tsx': 'export function NotFound() { return <p>Missing</p> }\n',
      'src/routes/index.tsx': 'export default function Home() { return <p>Home</p> }\n',
    })
    expect((await checkProject(dir, { skipTypecheck: true })).errors.sort()).toEqual([
      'src/routes/_404.tsx:1:1: error: kay check: src/routes/_404.tsx has no default export: export default its not-found page component.',
      'src/routes/_error.tsx:1:1: error: kay check: src/routes/_error.tsx has no default export: export default its error page component.',
      'src/routes/_layout.tsx:1:1: error: kay check: src/routes/_layout.tsx has no default export: export default its layout component.',
      'src/routes/admin/_middleware.ts:1:1: error: kay check: src/routes/admin/_middleware.ts has no default export: export default its middleware function.',
    ])
    await expect(build({ root: dir, minify: false })).rejects.toThrow('kay build: src/routes/_404.tsx has no default export: export default its not-found page component.')
  })

  it('fails on <Head> in a component that is an island because it reads imported state (#3583)', async () => {
    const dir = appWith('kay-parity-head-island-', {
      'src/state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n',
      'src/ui/Title.tsx': 'import { Head } from \'@kayjs/kay\'\nimport { count } from \'../state\'\nexport function Title() { return <Head><title>{String(count.value)}</title></Head> }\n',
      'src/routes/index.tsx': 'import { Title } from \'../ui/Title\'\nexport default function Home() { return <main><Title /></main> }\n',
    })
    const message = 'kay compiler: <Head> in an island in src/ui/Title.tsx: Title is an island because it reads count from \'../state\'; move <Head> to the page or a layout, outside any component with state or handlers.'
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([`src/ui/Title.tsx:3:55: error: ${message}`])
    await expect(build({ root: dir, minify: false })).rejects.toThrow(message)
  })

  it('agrees when a server-only module leaks into an island through a barrel re-export', async () => {
    const dir = makeTemp('kay-parity-leak-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/lib'), { recursive: true })
    mkdirSync(join(dir, 'src/components'), { recursive: true })

    writeFileSync(join(dir, 'src/lib/secret.ts'), `
      import { readFileSync } from 'node:fs'
      export const loadSecret = () => readFileSync('/etc/hostname', 'utf8')
    `)
    writeFileSync(join(dir, 'src/lib/index.ts'), `export { loadSecret } from './secret'\n`)

    writeFileSync(join(dir, 'src/components/LeakyIsland.tsx'), `
      import { signal } from '@kayjs/kay'
      import { loadSecret } from '../lib'
      export default function LeakyIsland() {
        const s = signal('')
        return <button onClick={() => { s.value = loadSecret() }}>{s.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import LeakyIsland from '../components/LeakyIsland'
      export default function Home() { return <LeakyIsland /> }
    `)

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.ok).toBe(false)
    expect(checked.errors.some(e => e.includes('node:fs'))).toBe(true)

    await expect(build({ root: dir, minify: false })).rejects.toThrow(/node:fs/)
  })

  it('agrees when a route passes a non-serializable function prop into a barrel-re-exported island', async () => {
    const dir = makeTemp('kay-parity-fn-prop-')
    linkKay(dir)
    mkdirSync(join(dir, 'src/routes'), { recursive: true })
    mkdirSync(join(dir, 'src/ui'), { recursive: true })

    writeFileSync(join(dir, 'src/ui/Btn.tsx'), `
      import { signal } from '@kayjs/kay'
      export function Btn({ onDone }: { onDone?: () => void }) {
        const n = signal(0)
        return <button onClick={() => { n.value++; onDone?.() }}>{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/ui/index.ts'), `export { Btn } from './Btn'\n`)
    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Btn } from '../ui'
      export default function Home() { return <Btn onDone={() => {}} /> }
    `)

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.ok).toBe(false)
    expect(checked.errors.some(e => e.includes('cannot pass function prop "onDone"'))).toBe(true)
  })
})

describe('kay check and kay build decide islands per component (#3587)', () => {
  const count = {
    'src/state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n',
    'src/ui/Count.tsx': [
      'import { count } from \'../state\'',
      'export function Label() { return <span>Count</span> }',
      'export function Total() { return <output>{count.value}</output> }',
      'export function Clicker() { return <button type="button" onClick={() => count.value++}>Add</button> }',
      'export default async function Summary() { return <p>Summary</p> }',
    ].join('\n'),
  }

  it('ships no JS for a page rendering only the static component of a file that also exports islands', async () => {
    const dir = appWith('kay-3587-build-', {
      ...count,
      'src/ui/Panel.tsx': [
        'import { Clicker, Total } from \'./Count\'',
        'const Frame = () => <Total />',
        'export function Live() { return <div onClick={() => 1}><Clicker /></div> }',
        'export function Shell() { return <section><Frame /></section> }',
      ].join('\n'),
      'kay.config.ts': 'export default { compliance: { legalNotice: false } }\n',
      'src/routes/index.tsx': 'import { Label } from \'../ui/Count\'\nexport default function Home() { return <main><Label /></main> }\n',
      'src/routes/counter.tsx': 'import { Label, Total } from \'../ui/Count\'\nexport default function Counter() { return <main><Label /><Total /></main> }\n',
      'src/routes/panel.tsx': 'import { Live, Shell } from \'../ui/Panel\'\nexport default function Panel() { return <main><Live /><Shell /></main> }\n',
    })
    expect(await checkProject(dir, { skipTypecheck: true })).toMatchObject({ errors: [], warnings: [] })
    const manifest = await build({ root: dir, minify: false })
    expect(Object.keys(manifest.islands).map(key => key.slice(dir.length)).sort()).toEqual(['/src/ui/Count.tsx#Total', '/src/ui/Panel.tsx#Live'])
    const chunks = Object.fromEntries(manifest.routes.map(route => [route.path, route.islandChunks.length]))
    expect(chunks).toEqual({ '/': 0, '/counter': 1, '/panel': 2 })
  })

  it('refuses a function prop into an island from a static component, and accepts it from an island of the same file', async () => {
    const dir = appWith('kay-3587-props-', {
      ...count,
      'src/ui/Panel.tsx': [
        'import { Clicker, Label } from \'./Count\'',
        'export function Live() { return <div onClick={() => 1}><Clicker onDone={() => 2} /></div> }',
        'export function Shell() { return <section><Clicker onDone={() => 3} /><Label render={() => 4} /></section> }',
      ].join('\n'),
      'src/routes/index.tsx': 'import { Live, Shell } from \'../ui/Panel\'\nexport default function Home() { return <main><Live /><Shell /></main> }\n',
    })
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([
      'src/ui/Panel.tsx:3:52: error: kay check: cannot pass function prop "onDone" from a server component into island <Clicker>. Define the handler inside the island or pass serializable data.',
    ])
    await expect(build({ root: dir, minify: false })).rejects.toThrow('src/ui/Panel.tsx:3:52: error: kay build: cannot pass function prop "onDone" from a server component into island <Clicker>. Define the handler inside the island or pass serializable data.')
  })
})

describe('a dynamic route that cannot be prerendered without paths() (#3657)', () => {
  it('fails kay check and kay build at its `prerender` export, naming the source file', async () => {
    const dir = appWith('kay-3657-paths-', {
      'src/routes/post/[id].tsx': 'export const prerender = true\nexport default function Post() { return <main>post</main> }\n',
    })
    const error = 'src/routes/post/[id].tsx:1:14: error: kay check: dynamic route exports `prerender = true` without exporting `paths()`: export `paths()` returning the URLs to prerender, or drop `prerender`.'
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([error])
    await expect(build({ root: dir, minify: false })).rejects.toThrow(error.replace('kay check:', 'kay build:'))
  })

  it('fails kay build --static on a dynamic page with no paths(), which a server build serves as is', async () => {
    const dir = appWith('kay-3657-static-paths-', {
      'src/routes/post/[id].tsx': 'export default function Post() { return <main>post</main> }\n',
    })
    await expect(build({ root: dir, minify: false, static: true })).rejects.toThrow('src/routes/post/[id].tsx:1:1: error: kay build: dynamic route has no `paths()`, so `kay build --static` cannot export it: export `paths()` returning its URLs.')
    expect((await build({ root: dir, minify: false })).routes.map(route => route.path)).toEqual(['/post/:id'])
  })

  it('leaves a dynamic API route alone under kay build --static', async () => {
    const dir = appWith('kay-3657-static-api-', {
      'src/routes/index.tsx': 'export default function Home() { return <main>home</main> }\n',
      'src/routes/api/[id].ts': 'export function GET() { return new Response(\'ok\') }\n',
    })
    await build({ root: dir, minify: false, static: true })
    expect(existsSync(join(dir, 'dist/index.html'))).toBe(true)
  })

  it('prerenders a dynamic page that exports both `prerender` and `paths()`', async () => {
    const dir = appWith('kay-3657-with-paths-', {
      'src/routes/post/[id].tsx': 'export const prerender = true\nexport function paths() { return [\'/post/1\'] }\nexport default function Post() { return <main>post</main> }\n',
    })
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([])
    await build({ root: dir, minify: false, static: true })
    expect(existsSync(join(dir, 'dist/post/1/index.html'))).toBe(true)
  })
})

describe('a handler or an async component the server cannot render (#3657)', () => {
  const button = 'export function Button(props: Record<string, unknown>) { return <button type="button" {...props}>b</button> }\n'
  const late = 'export async function Late() { await Bun.sleep(1); return <p>late</p> }\n'

  async function expectRefused(files: Record<string, string>, error: string): Promise<void> {
    const dir = appWith('kay-3657-render-', files)
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([error])
    await expect(build({ root: dir, minify: false })).rejects.toThrow(error.replace('kay check:', 'kay build:'))
  }

  async function expectAccepted(files: Record<string, string>): Promise<void> {
    const dir = appWith('kay-3657-render-ok-', files)
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([])
    await build({ root: dir, minify: false })
  }

  it('refuses an inline handler passed to an imported component that is not an island', async () => {
    await expectRefused({
      'src/ui/Button.tsx': button,
      'src/routes/index.tsx': 'import { Button } from \'../ui/Button\'\nexport default function Home() { return <main><Button onClick={() => 1} /></main> }\n',
    }, 'src/routes/index.tsx:2:55: error: kay check: cannot pass event handler "onClick" to <Button>, which is not an island: the server renders it as HTML, so the handler never runs. Write the handler inside <Button>, or render <Button> from an island.')
  })

  it('refuses a named handler passed to a component of the same file', async () => {
    await expectRefused({
      'src/routes/index.tsx': `const go = () => 1\n${button}export default function Home() { return <main><Button onPointerDown={go} /></main> }\n`,
    }, 'src/routes/index.tsx:3:55: error: kay check: cannot pass event handler "onPointerDown" to <Button>, which is not an island: the server renders it as HTML, so the handler never runs. Write the handler inside <Button>, or render <Button> from an island.')
  })

  it('accepts a function prop not named like an event, and a handler passed from inside an island', async () => {
    await expectAccepted({
      'src/ui/Button.tsx': button,
      'src/ui/List.tsx': 'export function List({ format }: { format: (n: number) => string }) { return <ul><li>{format(1)}</li></ul> }\n',
      'src/ui/Counter.tsx': 'import { signal } from \'@kayjs/kay\'\nimport { Button } from \'./Button\'\nexport function Counter() { const n = signal(0); return <Button onClick={() => n.value++} /> }\n',
      'src/routes/index.tsx': 'import { Counter } from \'../ui/Counter\'\nimport { List } from \'../ui/List\'\nexport default function Home() { return <main><List format={n => `#${n}`} /><Counter /></main> }\n',
    })
  })

  it('refuses an imported async component rendered outside <Suspense>, even from an async page', async () => {
    await expectRefused({
      'src/ui/Late.tsx': late,
      'src/routes/index.tsx': 'import { Late } from \'../ui/Late\'\nexport default async function Home() { return <main><Late /></main> }\n',
    }, 'src/routes/index.tsx:2:53: error: kay check: async component <Late> must be the only child of <Suspense>, or the page fails at its first request: render it as <Suspense fallback={...}><Late /></Suspense>.')
  })

  it('refuses an async component of the same file wrapped in an element inside <Suspense>', async () => {
    await expectRefused({
      'src/routes/index.tsx': `import { Suspense } from '@kayjs/kay'\n${late}export default function Home() { return <Suspense fallback={<p>wait</p>}><div><Late /></div></Suspense> }\n`,
    }, 'src/routes/index.tsx:3:79: error: kay check: async component <Late> must be the only child of <Suspense>, or the page fails at its first request: render it as <Suspense fallback={...}><Late /></Suspense>.')
  })

  it('places a browser global read while rendering at its file and line', async () => {
    const dir = appWith('kay-3657-global-', {
      'src/routes/index.tsx': 'export default function Home() {\n  return <main>{localStorage.getItem(\'t\')}</main>\n}\n',
    })
    expect((await checkProject(dir, { skipTypecheck: true })).warnings).toContain('src/routes/index.tsx:2:17: warning: kay compiler: `localStorage` read while <Home> renders in src/routes/index.tsx: the server has no `localStorage`, so it throws; read it in onMount() or an event handler, or check `typeof localStorage !== \'undefined\'` first.')
  })

  it('accepts an async component as the only child of <Suspense>, and an async page', async () => {
    await expectAccepted({
      'src/ui/Late.tsx': late,
      'src/routes/index.tsx': 'import { Suspense } from \'@kayjs/kay\'\nimport { Late } from \'../ui/Late\'\nexport default async function Home() { return <main><Suspense fallback={<p>wait</p>}>\n  <Late />\n</Suspense></main> }\n',
    })
  })
})

describe('kay check and kay build share island planning and reachability checks (#3599)', () => {
  it('surfaces a parse error in a broken import during state-read promotion instead of swallowing it', async () => {
    const dir = appWith('kay-3599-broken-state-', {
      'shared/broken-state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(\n',
      'src/state.ts': 'export { count } from \'../shared/broken-state\'\n',
      'src/routes/index.tsx': 'import { count } from \'../state\'\nexport default function Home() { return <output>{count.value}</output> }\n',
    })

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.ok).toBe(false)
    expect(checked.errors).toEqual([expect.stringMatching(/^shared\/broken-state\.ts:\d+:\d+: error: kay compiler: syntax error:/)])
    await expect(build({ root: dir, minify: false })).rejects.toThrow(/shared\/broken-state\.ts:.*syntax error/)
  })

  it('surfaces a parse error on a namespace state import outside src/ during state-read promotion', async () => {
    const dir = appWith('kay-3599-broken-ns-state-', {
      'shared/broken-state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(\n',
      'src/routes/index.tsx': 'import * as state from \'../../shared/broken-state\'\nexport default function Home() { return <output>{state.count.value}</output> }\n',
    })

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.ok).toBe(false)
    expect(checked.errors).toEqual([expect.stringMatching(/^shared\/broken-state\.ts:\d+:\d+: error: kay compiler: syntax error:/)])
    await expect(build({ root: dir, minify: false })).rejects.toThrow(/shared\/broken-state\.ts:.*syntax error/)
  })

  it('agrees on re-exports from a stubbed server action file (allows actions, rejects non-actions)', async () => {
    const okDir = appWith('kay-3599-action-reexport-ok-', {
      'src/actions/notes.ts': [
        'import { readFileSync } from \'node:fs\'',
        'import { action } from \'@kayjs/kay/server\'',
        'export const addNote = action(async () => readFileSync(\'/etc/hostname\', \'utf8\'))',
      ].join('\n'),
      'src/lib/actions.ts': 'export { addNote } from \'../actions/notes\'\n',
      'src/routes/index.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'import { addNote } from \'../lib/actions\'',
        'export default function Home() { const n = signal(0); return <button type="button" onClick={() => { n.value++; void addNote(undefined) }}>{n.value}</button> }',
      ].join('\n'),
    })
    expect(await checkProject(okDir, { skipTypecheck: true })).toMatchObject({ ok: true, errors: [] })
    const manifest = await build({ root: okDir, minify: false })
    expect(Object.keys(manifest.islands).length).toBe(1)

    const badDir = appWith('kay-3599-action-reexport-bad-', {
      'src/actions/notes.ts': [
        'import { action } from \'@kayjs/kay/server\'',
        'export const MAX_LENGTH = 140',
        'export const addNote = action(async () => \'ok\')',
      ].join('\n'),
      'src/lib/actions.ts': 'export { MAX_LENGTH } from \'../actions/notes\'\n',
      'src/routes/index.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'import { MAX_LENGTH } from \'../lib/actions\'',
        'export default function Home() { const n = signal(0); return <button type="button" onClick={() => n.value++}>{MAX_LENGTH - n.value}</button> }',
      ].join('\n'),
    })
    const checked = await checkProject(badDir, { skipTypecheck: true })
    expect(checked.ok).toBe(false)
    expect(checked.errors).toEqual([
      'src/lib/actions.ts:1:1: error: kay check: re-exports non-action "MAX_LENGTH" from server action file src/actions/notes.ts. Move MAX_LENGTH into a module without actions.',
    ])
    await expect(build({ root: badDir, minify: false })).rejects.toThrow(
      'kay build: src/lib/actions.ts runs in the browser and re-exports MAX_LENGTH from src/actions/notes.ts, a file of server actions: the browser only gets its actions. Move MAX_LENGTH into a module without actions.',
    )
  })

  it('refuses co-locating server action() inside an interactive .tsx file in both check and build (#3627)', async () => {
    // 1. Directly interactive .tsx page exporting an action
    const directDir = appWith('kay-3627-direct-action-', {
      'src/routes/index.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'import { action } from \'@kayjs/kay/server\'',
        'export const save = action(async () => ({ secret: \'NEVER_IN_CLIENT\' }))',
        'export default function Home() { const n = signal(0); return <button type="button" onClick={() => { n.value++; void save() }}>{n.value}</button> }',
      ].join('\n'),
    })
    const directCheck = await checkProject(directDir, { skipTypecheck: true })
    expect(directCheck.ok).toBe(false)
    expect(directCheck.errors).toEqual([
      expect.stringContaining('src/routes/index.tsx exports server action "save" and also uses browser interactivity'),
    ])
    await expect(build({ root: directDir, minify: false })).rejects.toThrow(
      /kay build: src\/routes\/index\.tsx exports server action "save" and also uses browser interactivity/,
    )

    // 2. State-read-promoted interactive .tsx component exporting an action
    const promotedDir = appWith('kay-3627-promoted-action-', {
      'src/state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n',
      'src/ui/Widget.tsx': [
        'import { action } from \'@kayjs/kay/server\'',
        'import { count } from \'../state\'',
        'export const save = action(async () => \'ok\')',
        'export function Widget() { return <output>{count.value}</output> }',
      ].join('\n'),
      'src/routes/index.tsx': 'import { Widget } from \'../ui/Widget\'\nexport default function Home() { return <main><Widget /></main> }\n',
    })
    const promotedCheck = await checkProject(promotedDir, { skipTypecheck: true })
    expect(promotedCheck.ok).toBe(false)
    expect(promotedCheck.errors).toEqual([
      expect.stringContaining('src/ui/Widget.tsx exports server action "save" and also uses browser interactivity'),
    ])
    await expect(build({ root: promotedDir, minify: false })).rejects.toThrow(
      /kay build: src\/ui\/Widget\.tsx exports server action "save" and also uses browser interactivity/,
    )

    // 3. Non-interactive static .tsx page co-locating an action remains allowed
    const staticDir = appWith('kay-3627-static-action-', {
      'src/routes/index.tsx': [
        'import { action } from \'@kayjs/kay/server\'',
        'export const save = action(async () => \'ok\')',
        'export default function Home() { return <form action={save} method="post"><button>Save</button></form> }',
      ].join('\n'),
    })
    expect(await checkProject(staticDir, { skipTypecheck: true })).toMatchObject({ ok: true, errors: [] })
    const manifest = await build({ root: staticDir, minify: false })
    expect(manifest.actions.map(a => a.exportName)).toEqual(['save'])
  })

  it('detects custom .ts hooks, exported state containers, and namespace imports of barrel-reexported state as islands (#3630)', async () => {
    const dir = appWith('kay-3630-missed-islands-', {
      'src/hooks/base.ts': 'import { signal } from \'@kayjs/kay\'\nexport function useBase(n: number) { return signal(n) }\n',
      'src/hooks/useCounter.ts': 'import { useBase } from \'./base\'\nexport function useCounter(start = 0) { const count = useBase(start); return { count } }\n',
      'src/state/raw.ts': 'import { signal } from \'@kayjs/kay\'\nexport const appState = { total: signal(1) }\nexport const liveCount = signal(2)\n',
      'src/state/index.ts': 'export * from \'./raw\'\n',
      'src/ui/HookWidget.tsx': 'import { useCounter } from \'../hooks/useCounter\'\nexport function HookWidget() { const { count } = useCounter(0); return <output>{count.value}</output> }\n',
      'src/ui/ContainerWidget.tsx': 'import { appState } from \'../state/raw\'\nexport function ContainerWidget() { return <output>{appState.total.value}</output> }\n',
      'src/ui/BarrelWidget.tsx': 'import * as S from \'../state\'\nexport function BarrelWidget() { return <output>{S.liveCount.value}</output> }\n',
      'src/routes/index.tsx': [
        'import { HookWidget } from \'../ui/HookWidget\'',
        'import { ContainerWidget } from \'../ui/ContainerWidget\'',
        'import { BarrelWidget } from \'../ui/BarrelWidget\'',
        'export default function Home() { return <main><HookWidget /><ContainerWidget /><BarrelWidget /></main> }',
      ].join('\n'),
    })
    expect(await checkProject(dir, { skipTypecheck: true })).toMatchObject({ ok: true, errors: [] })
    const manifest = await build({ root: dir, minify: false })
    expect(Object.keys(manifest.islands).map(k => k.slice(dir.length)).sort()).toEqual([
      '/src/ui/BarrelWidget.tsx#BarrelWidget',
      '/src/ui/ContainerWidget.tsx#ContainerWidget',
      '/src/ui/HookWidget.tsx#HookWidget',
    ])
  })

  it('catches cross-file <Head>/<Region>/<Suspense> inside islands, bare imported signals, wildcard action re-exports, and dynamic server-only imports in both check and build (#3630)', async () => {
    // 1. Cross-file <Head> rendered inside an island
    const headDir = appWith('kay-3630-cross-head-', {
      'src/ui/Seo.tsx': 'import { Head } from \'@kayjs/kay\'\nexport function Seo({ title }: { title: string }) { return <Head><title>{title}</title></Head> }\n',
      'src/ui/Widget.tsx': 'import { signal } from \'@kayjs/kay\'\nimport { Seo } from \'./Seo\'\nexport function Widget() { const n = signal(0); return <div><Seo title={String(n.value)} /><button onClick={() => n.value++}>+</button></div> }\n',
      'src/routes/index.tsx': 'import { Widget } from \'../ui/Widget\'\nexport default function Home() { return <main><Widget /></main> }\n',
    })
    const headCheck = await checkProject(headDir, { skipTypecheck: true })
    expect(headCheck.ok).toBe(false)
    expect(headCheck.errors).toEqual([expect.stringMatching(/^src\/ui\/Widget\.tsx:3:\d+: error: kay compiler: <Head> in an island in src\/ui\/Widget\.tsx:/)])
    await expect(build({ root: headDir, minify: false })).rejects.toThrow(/<Head> in an island/)

    // 2. Bare read of imported signal (named + namespace through barrel)
    const bareDir = appWith('kay-3630-bare-imported-', {
      'src/state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n',
      'src/barrel.ts': 'export * from \'./state\'\n',
      'src/routes/index.tsx': 'import { count } from \'../state\'\nimport * as S from \'../barrel\'\nexport default function Home() { return <p>{count} {S.count}</p> }\n',
    })
    const bareCheck = await checkProject(bareDir, { skipTypecheck: true })
    expect(bareCheck.ok).toBe(false)
    expect(bareCheck.errors.some(e => e.includes('count without .value'))).toBe(true)
    expect(bareCheck.errors.some(e => e.includes('S.count without .value'))).toBe(true)
    await expect(build({ root: bareDir, minify: false })).rejects.toThrow(/count without \.value/)

    // 3. Wildcard barrel re-export of a non-action from a server action file
    const actionBarrelDir = appWith('kay-3630-action-star-', {
      'src/actions/notes.ts': 'import { action } from \'@kayjs/kay/server\'\nexport const MAX = 10\nexport const add = action(async () => \'ok\')\n',
      'src/lib/barrel.ts': 'export * from \'../actions/notes\'\n',
      'src/routes/index.tsx': 'import { signal } from \'@kayjs/kay\'\nimport { MAX } from \'../lib/barrel\'\nexport default function Home() { const n = signal(0); return <button onClick={() => n.value++}>{MAX + n.value}</button> }\n',
    })
    const actionCheck = await checkProject(actionBarrelDir, { skipTypecheck: true })
    expect(actionCheck.ok).toBe(false)
    expect(actionCheck.errors.some(e => e.includes('non-action "MAX"'))).toBe(true)
    await expect(build({ root: actionBarrelDir, minify: false })).rejects.toThrow(/MAX/)

    // 4. Dynamic import() of server-only module inside an island (allowed inside load())
    const dynDir = appWith('kay-3630-dyn-import-', {
      'src/routes/index.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'export async function load() { const z = await import(\'node:zlib\'); return { ok: Boolean(z) } }',
        'export default function Home() { const n = signal(0); return <button onClick={async () => { await import(\'node:perf_hooks\'); n.value++ }}>{n.value}</button> }',
      ].join('\n'),
    })
    const dynCheck = await checkProject(dynDir, { skipTypecheck: true })
    expect(dynCheck.ok).toBe(false)
    expect(dynCheck.errors.some(e => e.includes('node:perf_hooks'))).toBe(true)
    expect(dynCheck.errors.some(e => e.includes('node:zlib'))).toBe(false)
    await expect(build({ root: dynDir, minify: false })).rejects.toThrow(/node:perf_hooks/)
  })
})

describe('process.env.NODE_ENV read by server code (#3681)', () => {
  it('warns where the server reads it, in kay check and kay build alike, and not in the code an island ships', async () => {
    const dir = appWith('kay-3681-', {
      'kay.config.ts': 'export const mode = process.env.NODE_ENV\nexport default { compliance: { legalNotice: false } }\n',
      'src/lib/mode.ts': 'export const isDev = process.env.NODE_ENV !== \'production\'\nexport const env = globalThis.process.env[\'NODE_ENV\']\n',
      'src/lib/own.ts': 'const process = { env: { NODE_ENV: \'test\' } }\nexport const mine = process.env.NODE_ENV\n',
      'src/lib/client.ts': 'export const label = process.env.NODE_ENV ?? \'unset\'\n',
      'src/components/Live.tsx': 'import { signal } from \'@kayjs/kay\'\nimport { label } from \'../lib/client\'\nexport function Live() { const n = signal(process.env.NODE_ENV); return <button onClick={() => { n.value = label }}>{n.value}</button> }\n',
      'src/routes/index.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'import { Live } from \'../components/Live\'',
        'import { env, isDev } from \'../lib/mode\'',
        'import { mine } from \'../lib/own\'',
        'export const prerender = true',
        'function Badge() { const on = signal(process.env.NODE_ENV === \'production\'); return <b onClick={() => { on.value = !on.value }}>{String(on.value)}</b> }',
        'export default function Home() {',
        '  const { NODE_ENV: mode } = process.env',
        '  return <main><p>{process.env.NODE_ENV}{mode}{String(isDev)}{env}{mine}</p><Live /><Badge /></main>',
        '}',
      ].join('\n'),
    })
    const expected = [
      'src/lib/mode.ts:1:22',
      'src/lib/mode.ts:2:20',
      'src/routes/index.tsx:8:11',
      'src/routes/index.tsx:9:20',
    ]
    const atOf = (lines: string[]) => lines.filter(l => l.includes('process.env.NODE_ENV read in')).map(l => l.split(': warning: ')[0]).sort()

    const checked = await checkProject(dir, { skipTypecheck: true })
    expect(checked.errors).toEqual([])
    expect(atOf(checked.warnings)).toEqual(expected)
    expect(checked.warnings).toContain('src/lib/mode.ts:1:22: warning: kay compiler: process.env.NODE_ENV read in src/lib/mode.ts: kay build does not set it, so a page it prerenders renders it unset; call nodeEnv() from @kayjs/kay/server, which returns the mode of the build or the server.')

    const printed: string[] = []
    const warn = spyOn(console, 'warn').mockImplementation((line: string) => { printed.push(line) })
    try {
      await build({ root: dir, minify: false })
    }
    finally {
      warn.mockRestore()
    }
    expect(atOf(printed)).toEqual(expected)
  })
})
