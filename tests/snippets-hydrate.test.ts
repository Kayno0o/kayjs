import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { child } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

const FILES: Record<string, string> = {
  'rows.kay': '--- <T>\nimport type { JSX } from \'kay\'\n\nconst { items, row } = props<{ items: T[], row: (item: T, index: number) => JSX.Element }>()\n---\nul.rows\n  for item, i of items key={i}\n    | {row(item, i)}\n',
  'island.kay': [
    '---',
    'import { signal } from \'kay\'',
    'import Rows from \'./rows.kay\'',
    '',
    'interface Branch { name: string, children: Branch[] }',
    '',
    'const count = signal(0)',
    'const names = signal([\'a\', \'b\'])',
    'const tree: Branch = { name: \'root\', children: [{ name: \'x\', children: [{ name: \'y\', children: [] }] }] }',
    '---',
    'snippet badge(text: string)',
    '  b.badge {text} {count()}',
    'snippet branch(node: Branch)',
    '  li {node.name}',
    '    if node.children.length > 0',
    '      ul',
    '        for next of node.children',
    '          {branch(next)}',
    'snippet item(name: string, i: number)',
    '  li.row {i}: {name}',
    'p#still still',
    '{badge(\'A\')}',
    '{badge(\'B\')}',
    'ul#tree',
    '  {branch(tree)}',
    'for name of names() key={name}',
    '  snippet tag()',
    '    i.tag {name}',
    '  p.loop {tag()}',
    'Rows(items={names()} row={item})',
    'section#sec',
    '  snippet note(text: string)',
    '    em.note {text}{count()}',
    '  {note(\'x\')}',
    'button#bump(onClick={() => count.set(count() + 1)}) Bump',
    'button#grow(onClick={() => names.set([...names(), \'c\'])}) Grow',
    '',
  ].join('\n'),
  'page.kay': '---\nimport Island from \'./island.kay\'\n---\nmain\n  Island\n',
}

let dir: string
let outdir: string
let pageHtml: string

beforeAll(async () => {
  dir = await scratchDir('snippets-hydrate-')
  outdir = join(dir, 'out')
  await Promise.all(Object.entries(FILES).map(async ([name, text]) => Bun.write(join(dir, name), text)))

  const { default: Page } = await import(join(dir, 'page.kay')) as { default: () => unknown }

  pageHtml = child(Page())

  const id = (/data-component="([^"]+)"/).exec(pageHtml)![1]!

  await Bun.write(join(dir, 'client.ts'), `import { hydrateIslands } from 'kay/client'\n\nexport const ready = hydrateIslands({ ${JSON.stringify(id)}: async () => import('./island.kay') })\n`)

  const build = await Bun.build({ entrypoints: [join(dir, 'client.ts')], outdir, target: 'browser', splitting: true, plugins: [kay()] })

  if (!build.success)
    throw new AggregateError(build.logs, 'client build failed')

  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  await rm(dir, { recursive: true, force: true })
})

const SNIPPET_NODES = '#still, .badge, #tree li, .loop, .tag, .row, .note'

// Whether each node is the one that stood there before hydration, not a copy of it.
function sameNodes(claimed: Element[]): boolean {
  const now = [...document.querySelectorAll(SNIPPET_NODES)]

  return now.length === claimed.length && now.every((node, index) => node === claimed[index])
}

const tick = async (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

describe('snippets in an island', () => {
  it('hydrate the markup the server wrote, claiming its nodes, and then follow the signals', async () => {
    document.body.innerHTML = pageHtml

    const claimed = [...document.querySelectorAll(SNIPPET_NODES)]
    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    expect(claimed).toHaveLength(13)
    await ready
    await tick()
    expect(sameNodes(claimed)).toBe(true)

    const bump = document.querySelector<HTMLButtonElement>('#bump')!

    bump.click()
    await tick()
    expect([...document.querySelectorAll('.badge')].map(badge => badge.textContent)).toEqual(['A 1', 'B 1'])
    expect(document.querySelector('.note')!.textContent).toBe('x1')
    expect(sameNodes(claimed)).toBe(true)

    document.querySelector<HTMLButtonElement>('#grow')!.click()
    await tick()
    expect([...document.querySelectorAll('.tag')].map(tag => tag.textContent)).toEqual(['a', 'b', 'c'])
    expect([...document.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['0: a', '1: b', '2: c'])
    expect(claimed.every(node => node.isConnected)).toBe(true)
  })
})
