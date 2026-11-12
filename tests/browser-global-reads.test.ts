import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { browserGlobalAtLoad } from '../src/check/browser-global-reads'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const roots: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const root = await scratchDir('browser-global-')

  roots.push(root)
  await Promise.all(Object.entries(files).map(async ([path, content]) => Bun.write(join(root, path), content)))

  return root
}

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('a module a server render reaches that reads a browser global as it loads', () => {
  const found = async (files: Record<string, string>) => {
    const root = await project(files)
    const components = new Map(await Promise.all(Object.keys(files).filter(file => file.endsWith('.kay')).map(async file => [join(root, file), files[file]!] as const)))

    const reads = await browserGlobalAtLoad(root, components, join(root, 'src/routes'))

    return reads.map(({ file, source, diagnostic }) => `${file.slice(root.length + 1)}:${source.slice(0, diagnostic.start).split('\n').length} ${diagnostic.message.slice(0, diagnostic.message.indexOf(','))}`)
  }
  const page = { 'src/routes/index.kay': '---\nimport { width } from \'../lib/width\'\n---\np {width}\n' }

  it('reports a top-level read in a module a page imports, directly and through another module', async () => {
    expect(await found({ ...page, 'src/lib/width.ts': 'export const width = window.innerWidth\n' })).toEqual(['src/lib/width.ts:1 `window` exists only in the browser'])
    expect(await found({ ...page, 'src/lib/width.ts': 'export { width } from \'./deep\'\n', 'src/lib/deep.ts': 'const store = localStorage.getItem(\'w\')\nexport const width = store\n' })).toEqual(['src/lib/deep.ts:1 `localStorage` exists only in the browser'])
  })

  it('reports it for an island the server renders too, and names the component reaching the module', async () => {
    const files = { 'src/routes/index.kay': '---\nimport Counter from \'../components/counter.kay\'\n---\nCounter\n', 'src/components/counter.kay': '---\nimport { signal } from \'kay\'\nimport { width } from \'../lib/width\'\n\nconst count = signal(width)\n---\nbutton(onClick={() => count++}) {count()}\n', 'src/lib/width.ts': 'export const width = window.innerWidth\n' }
    const root = await project(files)
    const [read] = await browserGlobalAtLoad(root, new Map(Object.entries(files).filter(([file]) => file.endsWith('.kay')).map(([file, source]) => [join(root, file), source])), join(root, 'src/routes'))

    expect(read?.diagnostic.message).toBe('`window` exists only in the browser, and this module reads it as it loads, which src/components/counter.kay reaches on the server')
  })

  it('passes typeof guards, early exits, a try, reads inside functions, dynamic imports and shadowed names', async () => {
    const guarded = [
      'export const a = typeof window === \'undefined\' ? 0 : window.innerWidth',
      'export const b = typeof document !== \'undefined\' && document.title',
      'export let c = 0\nif (typeof window !== \'undefined\')\n  c = window.innerWidth',
      'export let d = 0\ntry { d = localStorage.length } catch {}',
      'export const e = () => window.innerWidth\nexport function f() { return document.title }',
      'const window = { innerWidth: 1 }\nexport const g = window.innerWidth',
      'export const h = async () => (await import(\'./client-only\')).x',
      'export const i = [1].map(() => 1)\nexport type T = Window',
      'if (typeof window !== \'undefined\') {\n  localStorage.setItem(\'a\', \'b\')\n  document.title = \'x\'\n}',
      'export const j = typeof window === \'undefined\' ? \'\' : document.title',
      'export const k = typeof window !== \'undefined\' && localStorage.getItem(\'a\')',
      'if (typeof window === \'undefined\')\n  throw new Error(\'browser only\')\nexport const l = document.title',
      'export let m = 0\nif (typeof window !== \'undefined\' && typeof document !== \'undefined\')\n  m = document.title.length',
      'const isBrowser = typeof window !== \'undefined\'\nexport let n = 0\nif (isBrowser)\n  n = document.title.length',
      'export interface Navigation { parts: string[] }\nexport type Screen = { x: number }\nexport enum Location { A }',
    ]

    for (const body of guarded)
      expect(await found({ ...page, 'src/lib/width.ts': `export const width = 1\n${body}\n`, 'src/lib/client-only.ts': 'export const x = window.name\n' }), body).toEqual([])
  })

  it('leaves a component only a `--- client` one renders, and one no page renders', async () => {
    const marker = { 'src/components/marker.kay': '---\nimport { width } from \'../lib/width\'\n---\np {width}\n', 'src/lib/width.ts': 'export const width = window.innerWidth\n' }

    expect(await found({ 'src/routes/index.kay': '--- client\nimport Marker from \'../components/marker.kay\'\n---\nMarker\n', ...marker })).toEqual([])
    expect(await found({ 'src/routes/index.kay': 'p hi\n', ...marker })).toEqual([])
    expect(await found({ 'src/routes/index.kay': '---\nimport Marker from \'../components/marker.kay\'\n---\nMarker\n', ...marker })).toEqual(['src/lib/width.ts:1 `window` exists only in the browser'])
  })

  it('leaves a module no page imports, and one only a `--- client` component imports', async () => {
    expect(await found({ 'src/routes/index.kay': 'p hi\n', 'src/lib/width.ts': 'export const width = window.innerWidth\n' })).toEqual([])
    expect(await found({ 'src/routes/index.kay': '--- client\nimport { width } from \'../lib/width\'\n---\np {width}\n', 'src/lib/width.ts': 'export const width = window.innerWidth\n' })).toEqual([])
  })

  it('leaves a package alone, as its own load is probed', async () => {
    expect(await found({ 'src/routes/index.kay': '---\nimport { x } from \'pkg\'\n---\np {x}\n', 'node_modules/pkg/index.js': 'export const x = window.name\n', 'node_modules/pkg/package.json': '{"name":"pkg","version":"1.0.0","main":"index.js","type":"module"}' })).toEqual([])
  })
})

describe('a page whose render reads a browser global', () => {
  const serve = async (dev: boolean, reported: unknown[]) => {
    const root = await project({ 'routes/index.kay': '---\nconst width = window.innerWidth\n---\np {width}\n' })

    return new Elysia().use(await pages({ root, dirs: { routes: 'routes' }, observe: { onError: ({ error }) => void reported.push(error), log: false }, prebuilt: false, dev }))
  }

  for (const dev of [false, true]) {
    it(`names the global, the component and its line in the error, in ${dev ? 'development' : 'production'}`, async () => {
      const logged = spyOn(console, 'error').mockImplementation(() => undefined)
      const reported: unknown[] = []

      try {
        const answer = await (await serve(dev, reported)).handle(new Request('http://localhost/', { headers: { accept: 'text/html' } }))
        const body = await answer.text()

        expect(answer.status).toBe(500)
        expect((reported[0] as Error).message).toMatch(/^`window` exists only in the browser, and rendering .*routes\/index\.kay:2:\d+ on the server read it/)

        if (dev)
          expect(body).toContain('routes/index.kay:2:')
        else
          expect(body).toBe('Internal Server Error')
      }
      finally {
        logged.mockRestore()
      }
    })
  }
})
