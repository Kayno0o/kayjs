import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { child } from '../src/runtime/html'
import { turn } from './helpers/eventually'
import { scratchDir } from './scratch'

await plugin(kay())

const FILES: Record<string, string> = {
  'island.kay': [
    '---',
    'import { signal } from \'kay\'',
    '',
    'const log = signal(\'\')',
    'const add = (text: string) => log.set(log() + text)',
    '---',
    'div#outer(onClick|capture={() => add(\'c\')})',
    '  button#once(onClick|once={() => add(\'1\')}) once',
    '  div#self(onClick|once|self={() => add(\'s\')})',
    '    span#child x',
    'input#key(onKeyDown|space|enter={e => add(e.key === \' \' ? \'_\' : e.key)})',
    'form#form(onSubmit|capture|preventDefault={() => add(\'f\')}) go',
    'p#out {log()}',
    '',
  ].join('\n'),
  'page.kay': '---\nimport Island from \'./island.kay\'\n---\nmain\n  Island\n',
}

let dir: string
let outdir: string
let pageHtml: string

beforeAll(async () => {
  dir = await scratchDir('event-modifiers-hydrate-')
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

describe('event modifiers on a hydrated island', () => {
  it('claim the server markup, then run once, self, capture, key and submit modifiers', async () => {
    document.body.innerHTML = pageHtml

    const { ready } = await import(join(outdir, 'client.js')) as { ready: Promise<void> }

    await ready
    await turn()

    const out = document.querySelector('#out')!
    const press = (key: string, init: KeyboardEventInit = {}) => document.querySelector('#key')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }))

    document.querySelector<HTMLButtonElement>('#once')!.click()
    document.querySelector<HTMLButtonElement>('#once')!.click()
    // A click on the child does not spend the `once` of a `self` handler.
    document.querySelector<HTMLElement>('#child')!.click()
    document.querySelector<HTMLElement>('#self')!.click()
    document.querySelector<HTMLElement>('#self')!.click()
    press('a')
    press(' ')
    press('Enter')
    press('Enter', { isComposing: true })

    const submit = new Event('submit', { bubbles: true, cancelable: true })

    document.querySelector('#form')!.dispatchEvent(submit)
    await turn()
    expect(out.textContent).toBe('c1cccsc_Enterf')
    expect(submit.defaultPrevented).toBe(true)
  })
})
