import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
        'export function Shell() { return <section><Clicker onDone={() => 3} /><Label onPick={() => 4} /></section> }',
      ].join('\n'),
      'src/routes/index.tsx': 'import { Live, Shell } from \'../ui/Panel\'\nexport default function Home() { return <main><Live /><Shell /></main> }\n',
    })
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([
      'src/ui/Panel.tsx:3:52: error: kay check: cannot pass function prop "onDone" from a server component into island <Clicker>. Define the handler inside the island or pass serializable data.',
    ])
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
})
