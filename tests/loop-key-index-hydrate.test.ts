import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { child } from '../src/runtime/html'
import { eventually, turn } from './helpers/eventually'
import { scratchDir } from './scratch'

await plugin(kay())

const FILES: Record<string, string> = {
  'island.kay': [
    '---',
    'import { signal } from \'kay\'',
    '',
    'const rows = signal<{ id?: number, name: string }[]>([{ name: \'a\' }, { name: \'b\' }])',
    '---',
    'ul',
    '  for row, position of rows() key={row.id ?? position}',
    '    li.row {position}:{row.name}',
    'button#grow(onClick={() => rows.set([{ name: \'z\' }, { name: \'a\' }, { name: \'b\' }])}) Grow',
    '',
  ].join('\n'),
  'page.kay': '---\nimport Island from \'./island.kay\'\n---\nmain\n  Island\n',
}

let dir: string
let outdir: string
let pageHtml: string

beforeAll(async () => {
  dir = await scratchDir('loop-key-index-')
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

describe('a for key that reads the index, hydrated', () => {
  it('claims the rows the server wrote under the keys the index gives, so a later update keeps them', async () => {
    document.body.innerHTML = pageHtml

    const claimed = [...document.querySelectorAll('.row')]
    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    expect(claimed.map(row => row.textContent)).toEqual(['0:a', '1:b'])
    await ready
    await turn()
    expect([...document.querySelectorAll('.row')]).toEqual(claimed)

    document.querySelector<HTMLButtonElement>('#grow')!.click()
    await eventually(() => expect([...document.querySelectorAll('.row')].map(row => row.textContent)).toEqual(['0:z', '1:a', '2:b']))
    // The rows with no id are keyed by their place, 0 and 1, which the claimed rows hold: they stay, and a third is added.
    expect([...document.querySelectorAll('.row')].slice(0, 2)).toEqual(claimed)
  })
})
