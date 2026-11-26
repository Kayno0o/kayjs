// #3598: one tree builds into one chunk layout, so a before/after page weight compares the change and nothing else.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildManifest } from '../src/build/index'
import { analyzeBundleWeights, build } from '../src/build/index'
import { directKayImports } from '../src/build/client-plugin'
import { ModuleGraph } from '../src/build/graph'

const dir = mkdtempSync(join(tmpdir(), 'kay-3598-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function write(rel: string, code: string): void {
  mkdirSync(join(dir, rel, '..'), { recursive: true })
  writeFileSync(join(dir, rel), code)
}

write('src/actions/notes.ts', `
  import { action } from '@kayjs/kay/server'
  export const addNote = action(async () => ({ ok: true }))
`)
write('src/components/NoteForm.tsx', `
  import { useAction } from '@kayjs/kay'
  import { addNote } from '../actions/notes'
  export function NoteForm() {
    const add = useAction(addNote)
    return <button type="button" onClick={() => add.call({})}>{add.pending.value ? '...' : 'Add'}</button>
  }
`)
for (const name of ['Counter', 'Toggle']) {
  write(`src/components/${name}.tsx`, `
    import { effect, signal } from '@kayjs/kay'
    export function ${name}() {
      const n = signal(0)
      effect(() => { document.title = String(n.value) })
      return <button type="button" onClick={() => n.value++}>${name} {n.value}</button>
    }
  `)
}
write('src/routes/index.tsx', `
  import { Counter } from '../components/Counter'
  import { Toggle } from '../components/Toggle'
  export default function Home() { return <main><Counter /><Toggle /></main> }
`)
write('src/routes/notes.tsx', `
  import { Counter } from '../components/Counter'
  import { NoteForm } from '../components/NoteForm'
  export default function Notes() { return <main><Counter /><NoteForm /></main> }
`)

async function buildOnce(i: number): Promise<{ report: string, homeJs: string, manifest: BuildManifest }> {
  const outDir = `dist-${i}`
  const log = console.log
  let report = ''
  console.log = (...args: unknown[]) => { report += `${args.join(' ')}\n` }
  try {
    const manifest = await build({ root: dir, outDir, minify: true, prerender: false, copyPublic: false, analyze: true })
    const home = manifest.routes.find(r => r.path === '/')!
    const homeJs = home.islandChunks.map(url => readFileSync(join(dir, outDir, 'client', url.replace(/^\/_kay\//, '')), 'utf8')).join('\n')
    return { report, homeJs, manifest }
  }
  finally {
    console.log = log
  }
}

describe('#3598 reproducible client chunks', () => {
  test('six builds of one app print the same weight report, and a page without actions loads no action code', async () => {
    const runs = []
    for (let i = 0; i < 6; i++)
      runs.push(await buildOnce(i))
    expect(new Set(runs.map(r => r.report)).size).toBe(1)
    for (const run of runs)
      expect(run.homeJs).not.toContain('application/json')
  }, 60_000)
})

describe('#3574 weights without the metafile', () => {
  test('a report from the built files alone counts the shared chunks a route\'s islands import, as the analyze report does', async () => {
    const { report, manifest } = await buildOnce(9)
    const fromFiles = analyzeBundleWeights(manifest, join(dir, 'dist-9', 'client'))
    for (const route of fromFiles.routes) {
      const line = report.split('\n').find(l => l.startsWith(`${route.path} `))!
      expect(line).toContain(`${(route.jsGzip / 1024).toFixed(2)} KB`)
      expect(line).toContain(` ${route.jsFiles}j/`)
    }
  })

  test('a chunk that re-exports another counts it', () => {
    const client = join(dir, 'reexport')
    mkdirSync(client, { recursive: true })
    writeFileSync(join(client, 'island.js'), 'export{a}from"./shared.js";export*from"./more.js";')
    writeFileSync(join(client, 'shared.js'), 'export const a=1;')
    writeFileSync(join(client, 'more.js'), 'export const b=2;')
    const manifest = { styles: [], assets: [], routes: [{ path: '/', islandChunks: ['/_kay/island.js'] }] } as unknown as BuildManifest
    expect(analyzeBundleWeights(manifest, client).routes[0]!.jsFiles).toBe(3)
  })
})

describe('#3633 AST-aware directKayImports', () => {
  test('leaves @kayjs/kay inside string/template literals untouched and rewrites commented/typed top-level imports', () => {
    const graph = new ModuleGraph(dir)
    const src = [
      `// café 🚀 multi-byte comment before import`,
      `import { /* lead */ signal, type KayChild, effect as runEffect } from '@kayjs/kay'`,
      `export const docs = \``,
      `import { signal } from '@kayjs/kay'`,
      `\``,
      `export const snippet = "import { effect } from '@kayjs/kay'"`,
      `export const s = signal(1)`,
      `export const e = runEffect`,
    ].join('\n')

    const rewritten = directKayImports(src, graph, 'sample.tsx')
    // Top-level value imports rewritten away from the barrel despite inline comment
    expect(rewritten).toContain('import { signal, effect as runEffect } from ')
    expect(rewritten).toContain(`import { type KayChild } from '@kayjs/kay';`)
    // String & template literals remain verbatim (no absolute machine paths injected!)
    expect(rewritten).toContain("export const docs = `\nimport { signal } from '@kayjs/kay'\n`")
    expect(rewritten).toContain(`export const snippet = "import { effect } from '@kayjs/kay'"`)
    // Line count preserved
    expect(rewritten.split('\n').length).toBe(src.split('\n').length)
  })
})
