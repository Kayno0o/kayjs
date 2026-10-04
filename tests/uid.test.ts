import { mkdtemp, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { plugin } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { child } from '../src/runtime/html'
import { collectIslands } from '../src/runtime/island.server'
import { settle } from '../src/test'

plugin(kay())

const ID = /\bid="([^"]+)"/g

const FILES: Record<string, string> = {
  // Static: it draws ids, and stays static.
  'field.kay': '---\nimport { uid } from \'kay\'\n\nconst { label } = props<{ label: string }>()\nconst id = uid()\n---\nlabel(for={id}) {label}\ninput(id={id})\n',
  // Each row's ids come from the island's own count, the same on both sides.
  'option.kay': '---\nimport { uid } from \'kay\'\n\nconst { name } = props<{ name: string }>()\nconst id = uid()\n---\nli(id={id}) {name}\n',
  // Shows on a click the ids it drew in the browser, to compare with those the server wrote.
  'menu.kay': '---\nimport { signal, uid } from \'kay\'\nimport Option from \'./option.kay\'\n\nconst { names } = props<{ names: string[] }>()\nconst id = uid()\nconst open = signal(false)\nconst drawn: string[] = [id]\n---\nbutton(aria-controls={id} onClick={() => open.set(o => !o)}) Menu\nul(id={id})\n  for name of names key={name}\n    Option(name={name})\nif open()\n  p.drawn {drawn.join(\' \')}\n',
  'page.kay': '---\nimport Field from \'./field.kay\'\nimport Menu from \'./menu.kay\'\n---\nmain\n  Field(label="Name")\n  Field(label="Mail")\n  Menu(names={[\'a\', \'b\']})\n  Menu(names={[\'c\']})\n',
}

let dir: string
let html: string
let islands: number
let menu: string

beforeAll(async () => {
  dir = await mkdtemp(join(import.meta.dir, '.dom-'))
  await Promise.all(Object.entries(FILES).map(async ([name, text]) => Bun.write(join(dir, name), text)))
  menu = relative(process.cwd(), join(dir, 'menu.kay'))

  const { default: Page } = await import(join(dir, 'page.kay')) as { default: () => unknown }
  const rendered = collectIslands(() => child(Page()))

  html = rendered.result
  islands = rendered.islands.count
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('uid', () => {
  it('gives every component instance on the page its own id, a static component staying static', () => {
    const found = [...html.matchAll(ID)].map(match => match[1]!)

    // Two fields, two menus and three options.
    expect(found).toHaveLength(7)
    expect(new Set(found).size).toBe(7)
    expect(islands).toBe(2)
    expect(html).toContain(`<label for="${found[0]}">Name</label><input id="${found[0]}">`)
    expect(html.match(/data-uid="/g)).toHaveLength(2)
  })

  it('draws the same ids in the browser as the server wrote, island by island', async () => {
    const entry = join(dir, 'client.ts')

    await Bun.write(entry, `import { hydrateIslands } from 'kay/client'\n\nexport const ready = hydrateIslands({ ${JSON.stringify(menu)}: () => import('./menu.kay') })\n`)

    const build = await Bun.build({ entrypoints: [entry], outdir: join(dir, 'out'), target: 'browser', splitting: true, plugins: [kay()] })

    if (!build.success)
      throw new AggregateError(build.logs, 'client build failed')

    GlobalRegistrator.register()

    try {
      document.body.innerHTML = html

      // What the server wrote, before hydration could set anything.
      const written = [...document.querySelectorAll('slot[data-component]')].map(slot => [...slot.querySelectorAll('[id]')].map(element => element.id))
      const { ready } = await import(join(dir, 'out', 'client.js')) as { ready: Promise<void> }

      await ready

      for (const [index, slot] of [...document.querySelectorAll('slot[data-component]')].entries()) {
        slot.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }))
        await settle()
        expect(slot.querySelector('p.drawn')!.textContent).toBe(written[index]![0]!)
        expect([...slot.querySelectorAll('[id]')].map(element => element.id)).toEqual(written[index]!)
      }
    }
    finally {
      await GlobalRegistrator.unregister()
    }
  })
})
