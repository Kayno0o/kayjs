// A build writes into a stage folder and swaps it in only once every step passed, so a failure or a running `kay start` keeps the last dist/ (#3658).

import type { KayPlugin } from '../src/plugins/types'
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { build } from '../src/build/index'
import { startBuiltApp } from '../src/server/loader'
import { testApp } from '../src/test/index'

const tempDirs: string[] = []
const repoRoot = join(import.meta.dir, '../../..')

const COUNTER = `
  import { signal } from '@kayjs/kay'
  export function Counter() {
    const n = signal(0)
    return <button onClick={() => { n.value++ }}>{n.value}</button>
  }
`

function appWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'kay-swap-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/@kayjs/kay'))
  const all: Record<string, string> = {
    'src/components/Counter.tsx': COUNTER,
    'src/routes/index.tsx': `import { Counter } from '../components/Counter'\nexport default function Home() { return <main><h1>v1</h1><Counter /></main> }`,
    ...files,
  }
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  return dir
}

function write(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), text)
}

/** Every file of a folder by its path from the folder, with its bytes as text. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const ent of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (ent.isFile())
      files[relative(dir, join(ent.parentPath, ent.name))] = readFileSync(join(ent.parentPath, ent.name), 'latin1')
  }
  return files
}

/** What a build leaves beside its output: stage and backup folders. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter(name => name.includes('.stage-') || name.includes('.prev-'))
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('a failed build leaves the previous dist/ byte-identical (#3658)', () => {
  it('when a plugin build hook throws', async () => {
    const dir = appWith({})
    await build({ root: dir, minify: false })
    const before = snapshot(join(dir, 'dist'))
    write(dir, 'src/routes/about.tsx', 'export default function About() { return <p>about</p> }')
    const failing: KayPlugin = { name: 'failing', build: () => { throw new Error('plugin broke') } }

    await expect(build({ root: dir, minify: false, plugins: [failing] })).rejects.toThrow('plugin broke')

    expect(snapshot(join(dir, 'dist'))).toEqual(before)
    expect(leftovers(dir)).toEqual([])
  })

  it('when the leak check finds a server-only import in an island', async () => {
    const dir = appWith({})
    await build({ root: dir, minify: false })
    const before = snapshot(join(dir, 'dist'))
    write(dir, 'src/components/Counter.tsx', `import { Database } from 'bun:sqlite'\n${COUNTER.replace('signal(0)', 'signal(Database.length)')}`)

    await expect(build({ root: dir, minify: false })).rejects.toThrow('imports server-only module "bun:sqlite"')

    expect(snapshot(join(dir, 'dist'))).toEqual(before)
    expect(leftovers(dir)).toEqual([])
  })

  it('when a prerendered page throws', async () => {
    const dir = appWith({})
    await build({ root: dir, minify: false })
    const before = snapshot(join(dir, 'dist'))
    write(dir, 'src/routes/broken.tsx', `export const prerender = true\nexport default function Broken() { throw new Error('render failure') }`)

    await expect(build({ root: dir, minify: false })).rejects.toThrow('prerender route "/broken"')

    expect(snapshot(join(dir, 'dist'))).toEqual(before)
    expect(leftovers(dir)).toEqual([])
  })

  it('when a --static page throws', async () => {
    const dir = appWith({})
    await build({ root: dir, static: true, minify: false })
    const before = snapshot(join(dir, 'dist'))
    write(dir, 'src/routes/broken.tsx', `export default function Broken() { throw new Error('render failure') }`)

    await expect(build({ root: dir, static: true, minify: false })).rejects.toThrow('prerender route "/broken"')

    expect(snapshot(join(dir, 'dist'))).toEqual(before)
    expect(leftovers(dir)).toEqual([])
  })
})

describe('a successful build replaces dist/ only once every step has passed (#3658)', () => {
  // The last hook of a build sees the previous dist/ still in place, then the new one lands whole.
  const watcher = (dir: string, outDir: string, seen: string[]): KayPlugin => ({
    name: 'watcher',
    afterPrerender: () => {
      seen.push(readFileSync(join(dir, outDir, 'manifest.json'), 'utf8').includes('"/about"') ? 'new' : 'old')
    },
  })

  it('into the default dist/', async () => {
    const dir = appWith({ 'src/routes/kept.tsx': 'export const prerender = true\nexport default function Kept() { return <p>kept</p> }' })
    await build({ root: dir, minify: false })
    write(dir, 'src/routes/about.tsx', 'export default function About() { return <p>about</p> }')
    const seen: string[] = []

    await build({ root: dir, minify: false, plugins: [watcher(dir, 'dist', seen)] })

    expect(seen).toEqual(['old'])
    expect(readFileSync(join(dir, 'dist/manifest.json'), 'utf8')).toContain('"/about"')
    expect(existsSync(join(dir, 'dist/prerendered/kept/index.html'))).toBe(true)
    expect(leftovers(dir)).toEqual([])
  })

  it('into a custom outDir', async () => {
    const dir = appWith({ 'src/routes/kept.tsx': 'export const prerender = true\nexport default function Kept() { return <p>kept</p> }' })
    await build({ root: dir, outDir: 'out/site', minify: false })
    write(dir, 'src/routes/about.tsx', 'export default function About() { return <p>about</p> }')
    const seen: string[] = []

    await build({ root: dir, outDir: 'out/site', minify: false, plugins: [watcher(dir, 'out/site', seen)] })

    expect(seen).toEqual(['old'])
    expect(readFileSync(join(dir, 'out/site/manifest.json'), 'utf8')).toContain('"/about"')
    expect(leftovers(join(dir, 'out'))).toEqual([])
  })

  it('under --static, where the previous export stays until the swap', async () => {
    const dir = appWith({})
    await build({ root: dir, static: true, minify: false })
    write(dir, 'src/routes/about.tsx', 'export default function About() { return <p>about</p> }')
    const seen: string[] = []
    const staticWatcher: KayPlugin = { name: 'watcher', afterPrerender: () => { seen.push(readdirSync(join(dir, 'dist')).filter(name => !name.startsWith('.')).sort().join(' ')) } }

    await build({ root: dir, static: true, minify: false, plugins: [staticWatcher] })

    expect(seen).toEqual(['_kay index.html index.html.br index.html.gz'])
    expect(existsSync(join(dir, 'dist/about/index.html'))).toBe(true)
  })
})

describe('kay only replaces a folder it marked as its own output (#3658)', () => {
  it('refuses an outDir holding files kay did not build, naming it, and leaves them alone', async () => {
    const dir = appWith({ 'site/notes.txt': 'mine', 'site/manifest.json': '{}' })

    await expect(build({ root: dir, outDir: 'site', minify: false })).rejects.toThrow('kay build: refusing to replace "site": it holds files kay did not build. Delete it, or set `outDir` in kay.config.ts to a folder of its own.')

    expect(snapshot(join(dir, 'site'))).toEqual({ 'notes.txt': 'mine', 'manifest.json': '{}' })
    expect(leftovers(dir)).toEqual([])
  })

  it('refuses the same under --static', async () => {
    const dir = appWith({ 'site/server/notes.txt': 'mine' })

    await expect(build({ root: dir, outDir: 'site', static: true, minify: false })).rejects.toThrow('kay build: refusing to replace "site"')

    expect(snapshot(join(dir, 'site'))).toEqual({ 'server/notes.txt': 'mine' })
  })

  it('removes the stage a killed build left, and keeps one a running build owns', async () => {
    const dir = appWith({})
    const dead = [join(dir, '.dist.stage-999999999-1-a'), join(dir, '.dist.prev-999999999-1-a'), join(dir, '.kay-cache/.static-stage-999999999-1-a')]
    const live = join(dir, `.dist.prev-${process.ppid}-1-a`)
    for (const folder of [...dead, live])
      mkdirSync(folder, { recursive: true })

    await build({ root: dir, minify: false })

    expect(dead.filter(folder => existsSync(folder))).toEqual([])
    expect(existsSync(live)).toBe(true)
  })

  it('replaces its own static export of pages that ship no asset at all', async () => {
    const dir = appWith({ 'src/routes/index.tsx': 'export default function Home() { return <p>plain</p> }' })
    await build({ root: dir, static: true, minify: false })
    write(dir, 'src/routes/index.tsx', 'export default function Home() { return <p>plain again</p> }')

    await build({ root: dir, static: true, minify: false })

    expect(readFileSync(join(dir, 'dist/index.html'), 'utf8')).toContain('plain again')
  })

  it('marks what it builds, and replaces an empty folder or an earlier kay build that has no mark', async () => {
    const dir = appWith({})
    mkdirSync(join(dir, 'dist'))
    await build({ root: dir, minify: false })
    expect(existsSync(join(dir, 'dist/.kay-output'))).toBe(true)

    rmSync(join(dir, 'dist/.kay-output'))
    await build({ root: dir, minify: false })
    expect(existsSync(join(dir, 'dist/.kay-output'))).toBe(true)

    await build({ root: dir, static: true, minify: false })
    expect(existsSync(join(dir, 'dist/.kay-output'))).toBe(true)
    rmSync(join(dir, 'dist/.kay-output'))
    await build({ root: dir, static: true, minify: false })
    expect(existsSync(join(dir, 'dist/index.html'))).toBe(true)
  })
})

describe('kay start keeps answering while kay build writes the same dist/ (#3658)', () => {
  it('serves the page and its island script from the previous build until the swap', async () => {
    const dir = appWith({})
    const first = await build({ root: dir, minify: false })
    const { app } = await startBuiltApp({ root: dir, outDir: 'dist' })
    write(dir, 'src/components/Counter.tsx', COUNTER.replace('signal(0)', 'signal(1)'))
    // A file served from disk answers 200 before its body is read, so each probe reads the body too.
    const failures: string[] = []
    const probe: KayPlugin = {
      name: 'probe',
      build: async () => {
        for (const path of ['/', ...first.assets.map(rel => `/_kay/${rel}`)]) {
          const res = await app.handle(new Request(`http://localhost${path}`))
          const body = await res.text().catch((err: Error) => err.message)
          if (res.status !== 200 || body.startsWith('ENOENT'))
            failures.push(`${path}: ${res.status} ${body.slice(0, 80)}`)
        }
      },
    }

    try {
      await build({ root: dir, minify: false, plugins: [probe] })
    }
    finally {
      await app.dispose?.()
    }

    expect(first.assets.length).toBeGreaterThan(1)
    expect(failures).toEqual([])
  })
})

describe('testApp() leaves the app\'s dist/ alone (#3658)', () => {
  it('builds into a folder of its own when no outDir is given', async () => {
    const dir = appWith({})
    await build({ root: dir, minify: false })
    const before = snapshot(join(dir, 'dist'))
    write(dir, 'src/routes/about.tsx', 'export default function About() { return <p>about</p> }')

    const t = await testApp({ root: dir })

    expect((await t.get('/about')).status).toBe(200)
    expect(snapshot(join(dir, 'dist'))).toEqual(before)
  })

  it('removes its folder when the test process exits', async () => {
    const dir = appWith({})
    write(dir, 'run.ts', `import { testApp } from '@kayjs/kay/test'\nconst t = await testApp({ root: import.meta.dir })\nif ((await t.get('/')).status !== 200) process.exit(3)\n`)

    const proc = Bun.spawnSync(['bun', 'run.ts'], { cwd: dir, stderr: 'pipe' })

    expect(proc.exitCode).toBe(0)
    expect(existsSync(join(dir, '.kay-cache'))).toBe(false)
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })

  it('reads the app\'s dist/ with prebuilt: true', async () => {
    const dir = appWith({})
    await build({ root: dir, minify: false })
    const before = snapshot(join(dir, 'dist'))

    const t = await testApp({ root: dir, prebuilt: true })

    expect((await t.get('/')).status).toBe(200)
    expect(snapshot(join(dir, 'dist'))).toEqual(before)
  })

  it('reuses the latest testApp() build of the same app with prebuilt: true', async () => {
    const dir = appWith({})
    await testApp({ root: dir })
    write(dir, 'src/routes/index.tsx', 'export default function Home() { return <p>changed, not rebuilt</p> }')

    const t = await testApp({ root: dir, prebuilt: true })

    expect(await (await t.get('/')).text()).toContain('<h1>v1</h1>')
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })

  it('builds into an explicit outDir', async () => {
    const dir = appWith({})

    const t = await testApp({ root: dir, outDir: 'test-dist' })

    expect((await t.get('/')).status).toBe(200)
    expect(existsSync(join(dir, 'test-dist/manifest.json'))).toBe(true)
    expect(existsSync(join(dir, 'dist'))).toBe(false)
  })
})
