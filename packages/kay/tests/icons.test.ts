import type { IconSet } from '../../plugin-icons/src/index'
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { icons } from '../../plugin-icons/src/plugin'
import { build } from '../src/build/index'

const DEMO: IconSet = { prefix: 'demo', width: 24, height: 24, icons: { arrow: { body: '<path d="M5 12h14"/>' } } }
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

// An app installing @kayjs/icons and @kayjs/kay as links, the way a workspace or `file:` dependency does.
function linkedApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kay-icons-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules/@kayjs'), { recursive: true })
  symlinkSync(join(import.meta.dir, '../../plugin-icons'), join(root, 'node_modules/@kayjs/icons'))
  symlinkSync(join(import.meta.dir, '..'), join(root, 'node_modules/@kayjs/kay'))

  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), source)
  }

  return root
}

function clientJs(root: string): string {
  const dir = join(root, 'dist/_kay')
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.js')).map(file => readFileSync(join(dir, file), 'utf8')).join('\n')
}

describe('@kayjs/icons in an island', () => {
  it('builds an island rendering <Icon> imported from @kayjs/icons', async () => {
    const root = linkedApp({
      'src/Counter.tsx': `
        import { signal } from '@kayjs/kay'
        import { Icon } from '@kayjs/icons'
        import arrow from '~icons/demo/arrow'
        export function Counter() {
          const count = signal(0)
          return <button onClick={() => count.value++}><Icon icon={arrow} />{count.value}</button>
        }
      `,
      'src/routes/index.tsx': `
        import { Counter } from '../Counter'
        export default function Home() { return <main><Counter /></main> }
      `,
    })

    await build({ root, plugins: [icons({ sets: { demo: DEMO } })], static: true })

    expect(clientJs(root)).toContain('M5 12h14')
  })
})
