// A component of the same file that runs in the browser is an island where it is rendered, and the components around it stay static (#3661).

import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneForClient } from '../src/build/client-prune'
import { build } from '../src/build/index'
import { checkProject } from '../src/cli/check'
import { runCli } from '../src/cli/index'
import { parseTsx } from '../src/compiler/analyze'
import { testApp, testBrowser } from '../src/test/index'

const tempDirs: string[] = []
const repoRoot = join(import.meta.dir, '../../..')

function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-3661-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/@kayjs/kay'))
  for (const [file, text] of Object.entries({ 'kay.config.ts': 'export default { compliance: { legalNotice: false } }\n', ...files })) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

const counter = [
  'import { signal } from \'@kayjs/kay\'',
  'function Counter({ start }: { start: number }) { const n = signal(start); return <button type="button" class="count" onClick={() => n.value++}>{n.value}</button> }',
].join('\n')

// Unit is static and rendered both by the static sections and inside the widget, so its HTML must carry markers for the widget to claim.
const repro = {
  'src/routes/index.tsx': [
    'import { signal } from \'@kayjs/kay\'',
    'function Unit({ n }: { n: number }) { return <small>{n} {n === 1 ? \'click\' : \'clicks\'}</small> }',
    'function Counter({ start }: { start: number }) { const n = signal(start); return <button type="button" class="count" aria-label="Count" onClick={() => n.value++}><Unit n={n.value} /></button> }',
    'function Section({ n }: { n: number }) { return <section><h2>Static section heading {n}</h2><p>Plain prose, <Unit n={n} /> so far.</p><Counter start={n} /></section> }',
    'export default function Home() { return <main>{[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(n => <Section n={n} />)}</main> }',
  ].join('\n'),
}

function islandChunkText(dir: string): string {
  const chunks = readdirSync(join(dir, 'dist/client')).filter(f => f.startsWith('index-counter') && f.endsWith('.js'))
  return chunks.map(f => readFileSync(join(dir, 'dist/client', f), 'utf8')).join('\n')
}

describe('the client copy of a module holding islands (#3661)', () => {
  it('keeps the declarations, imports and exports the islands reach, and the module-level code', () => {
    const code = [
      'import { a, type U, b as c } from \'./x\'',
      'import { type V, w } from \'./v\'',
      'import D, * as NS from \'./y\'',
      'import \'./side.css\'',
      'import type { T } from \'./t\'',
      'import data, { unused } from \'./d.json\' with { type: \'json\' }',
      'const kept = a + NS.n',
      'const dropped = c()',
      'function Widget(): T { return kept }',
      'export function Page() { return D }',
      'export { Widget as Shown, dropped }',
      'export { r } from \'./r\'',
      'export * from \'./all\'',
      'export default Page',
      'sideEffect()',
    ].join('\n')
    expect(pruneForClient(code, parseTsx('m.tsx', code), new Set(['a', 'w', 'NS', 'data', 'kept', 'Widget']))).toBe([
      'import { a } from \'./x\'; import { type U } from \'./x\';',
      'import { type V, w } from \'./v\'',
      'import * as NS from \'./y\';',
      'import \'./side.css\'',
      'import type { T } from \'./t\'',
      'import data, { unused } from \'./d.json\' with { type: \'json\' }',
      'const kept = a + NS.n',
      '',
      'function Widget(): T { return kept }',
      '',
      'export { Widget as Shown };',
      '',
      '',
      '',
      'sideEffect()',
    ].join('\n'))
  })
})

describe('a same-file widget is its own island (#3661)', () => {
  it('hydrates only the widget of a page of static sections, and ships none of their code', async () => {
    const dir = appWith(repro)
    const manifest = await build({ root: dir, minify: false })
    expect(Object.keys(manifest.islands).map(key => key.slice(dir.length))).toEqual(['/src/routes/index.tsx#Counter'])
    expect(manifest.routes.find(r => r.path === '/')!.islandChunks).toHaveLength(1)
    const chunk = islandChunkText(dir)
    expect(chunk).toContain('$$click')
    expect(chunk).not.toContain('Static section heading')

    const t = await testApp({ root: dir, prebuilt: true })
    const html = await (await t.get('/')).text()
    expect(html.match(/<kay-island/g)).toHaveLength(12)
    expect(html).toContain('<h2>Static section heading 1</h2>')
  })

  it('names the widget in kay build --analyze', async () => {
    const dir = appWith(repro)
    const logs: string[] = []
    const log = spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
    try {
      expect(await runCli(['build', '--analyze'], { cwd: dir })).toBe(0)
    }
    finally {
      log.mockRestore()
    }
    expect(logs.join('\n').split('\n').filter(line => line.startsWith('  island'))).toEqual([
      '  island: Counter (src/routes/index.tsx) uses signal',
    ])
  })

  it('lets an async page and a layout render a local widget', async () => {
    const dir = appWith({
      'src/routes/_layout.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'function Menu() { const open = signal(false); return <button type="button" onClick={() => open.value = !open.value}>{open.value ? \'Close\' : \'Menu\'}</button> }',
        'export default function Layout({ children }: { children: unknown }) { return <div><header><Menu /></header>{children}</div> }',
      ].join('\n'),
      'src/routes/index.tsx': [
        counter,
        'export default async function Home() { const title = await Promise.resolve(\'Awaited title\'); return <main><h1>{title}</h1><Counter start={3} /></main> }',
      ].join('\n'),
    })
    expect(await checkProject(dir, { skipTypecheck: true })).toMatchObject({ errors: [] })
    const manifest = await build({ root: dir, minify: false })
    expect(Object.keys(manifest.islands).map(key => key.slice(dir.length)).sort()).toEqual(['/src/routes/_layout.tsx#Menu', '/src/routes/index.tsx#Counter'])
    const t = await testApp({ root: dir, prebuilt: true })
    const html = await (await t.get('/')).text()
    expect(html).toContain('Awaited title')
    expect(html.match(/<kay-island/g)).toHaveLength(2)
  })

  it('keeps the server code of a page out of its local widget, and ships a module whole once other island code imports it', async () => {
    const dir = appWith({
      'src/lib/host.ts': 'import { hostname } from \'node:os\'\nexport const host = (): string => hostname().length > 0 ? \'Read on the server\' : \'\'\n',
      'src/routes/index.tsx': [
        counter,
        'import { host } from \'../lib/host\'',
        'export { host as hostName } from \'../lib/host\'',
        'export default async function Home() { const h = await Promise.resolve(host()); const lazy = await import(\'../lib/host\'); return <main><h1>{h}</h1><p>{typeof lazy.host}</p><Counter start={1} /></main> }',
      ].join('\n'),
    })
    expect(await checkProject(dir, { skipTypecheck: true })).toMatchObject({ errors: [] })
    await build({ root: dir, minify: false })
    expect(islandChunkText(dir)).not.toContain('hostname')
    const t = await testApp({ root: dir, prebuilt: true })
    expect(await (await t.get('/')).text()).toContain('<h1>Read on the server</h1>')

    writeFileSync(join(dir, 'src/routes/live.tsx'), [
      'import { signal } from \'@kayjs/kay\'',
      'import Home from \'./index\'',
      'function Live() { const open = signal(false); return <div onClick={() => open.value = true}><Home /></div> }',
      'export default function Page() { return <Live /> }',
    ].join('\n'))
    await expect(build({ root: dir, minify: false })).rejects.toThrow('src/lib/host.ts imports server-only module "node:os"')
  })

  it('refuses a function prop passed from the static component of the file into the widget', async () => {
    const dir = appWith({
      'src/routes/index.tsx': [
        'import { signal } from \'@kayjs/kay\'',
        'function Counter({ onDone }: { onDone: () => void }) { const n = signal(0); return <button type="button" onClick={() => { n.value++; onDone() }}>{n.value}</button> }',
        'export default function Home() { return <main><Counter onDone={() => 1} /></main> }',
      ].join('\n'),
    })
    expect((await checkProject(dir, { skipTypecheck: true })).errors).toEqual([
      'src/routes/index.tsx:3:56: error: kay check: cannot pass function prop "onDone" from a server component into island <Counter>. Define the handler inside the island or pass serializable data.',
    ])
    await expect(build({ root: dir, minify: false })).rejects.toThrow('cannot pass function prop "onDone" from a server component into island <Counter>')
  })

  it('keeps a widget rendered inside another island of the file part of that island, and shares an exported one with the pages importing it', async () => {
    const dir = appWith({
      'src/ui/widgets.tsx': [
        counter,
        'export function Panel() { const open = signal(false); return <div><button type="button" onClick={() => open.value = !open.value}>Toggle</button><Counter start={1} /></div> }',
        'export function Tally() { const n = signal(0); return <output onClick={() => n.value++}>{n.value}</output> }',
        'export function Board() { return <section><Tally /><Panel /></section> }',
      ].join('\n'),
      'src/routes/index.tsx': 'import { Board, Tally } from \'../ui/widgets\'\nexport default function Home() { return <main><Board /><Tally /></main> }\n',
    })
    const manifest = await build({ root: dir, minify: false })
    expect(Object.keys(manifest.islands).map(key => key.slice(dir.length)).sort()).toEqual(['/src/ui/widgets.tsx#Panel', '/src/ui/widgets.tsx#Tally'])
  })

  it('makes a local component reading an imported store an island of its own', async () => {
    const dir = appWith({
      'src/state.ts': 'import { signal } from \'@kayjs/kay\'\nexport const count = signal(0)\n',
      'src/routes/index.tsx': [
        counter,
        'import { count } from \'../state\'',
        'function Total() { return <output>{count.value}</output> }',
        'export default function Home() { return <main><Counter start={1} /><Total /></main> }',
      ].join('\n'),
    })
    const manifest = await build({ root: dir, minify: false })
    expect(Object.keys(manifest.islands).map(key => key.slice(dir.length)).sort()).toEqual(['/src/routes/index.tsx#Counter', '/src/routes/index.tsx#Total'])
  })

  it('defers a local widget given $hydrate', async () => {
    const dir = appWith({
      'src/routes/index.tsx': [
        counter,
        'export default function Home() { return <main><Counter start={1} $hydrate="visible" /></main> }',
      ].join('\n'),
    })
    const manifest = await build({ root: dir, minify: false })
    const home = manifest.routes.find(r => r.path === '/')!
    expect(home.islandChunks).toHaveLength(1)
    expect(home.eagerIslandChunks ?? []).toEqual([])
  })

  it('clicks a same-file widget in the browser, the page calling server code at its top level', async () => {
    const dir = appWith({
      'src/lib/host.ts': 'import { hostname } from \'node:os\'\nexport const host = (): string => hostname()\n',
      'src/routes/index.tsx': `import { host } from '../lib/host'\nconst where = host()\n${repro['src/routes/index.tsx'].replace('<main>', '<main data-host={where}>')}`,
    })
    const browser = await testBrowser({ root: dir })
    try {
      const page = await browser.open('/')
      await page.click('section:nth-of-type(3) .count')
      await page.waitFor(() => document.querySelectorAll('.count')[2]?.textContent === '4 clicks')
      expect(await page.evaluate(() => [...document.querySelectorAll('.count')].slice(0, 4).map(b => b.textContent).join(','))).toBe('1 click,2 clicks,4 clicks,4 clicks')
      expect(page.errors).toEqual([])
    }
    finally {
      await browser.close()
    }
  }, 60_000)
})
