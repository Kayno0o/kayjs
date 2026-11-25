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
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/kay'))
  symlinkSync(join(repoRoot, 'packages/kay'), join(dir, 'node_modules/@kayjs/kay'))
}

afterAll(() => {
  for (const d of tempDirs)
    rmSync(d, { recursive: true, force: true })
})

describe('kay check and kay build graph/route parity (#3567)', () => {
  it('agrees on _-prefixed subdirs, non-handler helpers, and barrel re-exports', async () => {
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

    // Non-handler helper inside routes/: exports helper fn only, no default component / HTTP verb
    writeFileSync(join(dir, 'src/routes/helpers.ts'), `
      export function shout(s: string): string { return s.toUpperCase() }
    `)

    // Barrel re-exporting an interactive island
    writeFileSync(join(dir, 'src/ui/Counter.tsx'), `
      import { signal } from 'kay'
      export function Counter({ start }: { start: number }) {
        const n = signal(start)
        return <button onClick={() => n.value++}>{n.value}</button>
      }
    `)
    writeFileSync(join(dir, 'src/ui/index.ts'), `export { Counter } from './Counter'\n`)

    writeFileSync(join(dir, 'src/routes/index.tsx'), `
      import { Badge } from './_components/Badge'
      import { shout } from './helpers'
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
      import { signal } from 'kay'
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
      import { signal } from 'kay'
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
