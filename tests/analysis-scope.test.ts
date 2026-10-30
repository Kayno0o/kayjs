import { describe, expect, it, spyOn } from 'bun:test'
import { browserRole, inAnalysisScope, rendersAsIsland } from '../src/compiler'
import * as markdown from '../src/compiler/markdown-block'

const SOURCES: [name: string, file: string, text: string][] = [
  ['static', 'card.kay', 'p hi\n'],
  ['interactive', 'counter.kay', '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(onClick={() => n = n() + 1}) {n()}\n'],
  ['client', 'map.kay', '--- client\nconst x = 1\n---\np {x}\n'],
  ['promotable', 'list.kay', '---\nimport Picker from \'./picker.kay\'\n\nfunction pick() {}\n---\nPicker(select={pick})\n'],
  ['route file with a handler', '_layout.kay', '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(onClick={() => n = 1}) x\n'],
  ['server page', 'page.kay', '--- server\nconst a = 1\n---\np {a}\n'],
]
const LIVE = { './live': { count: 'live' } } as never

describe('the analysis scope of a check', () => {
  it('answers as it does outside a scope, for every kind of component', async () => {
    const outside = SOURCES.map(([, file, text]) => [rendersAsIsland(text), browserRole(text, file), rendersAsIsland(text, LIVE), browserRole(text, file, LIVE)])
    const inside = await inAnalysisScope(async () => SOURCES.map(([, file, text]) => [rendersAsIsland(text), browserRole(text, file), rendersAsIsland(text, LIVE), browserRole(text, file, LIVE)]))

    expect(inside).toEqual(outside)
    expect(outside.map(row => row[1])).toEqual([undefined, 'island', 'island', 'promotable', 'island', undefined])
  })

  it('parses a component once for every question about it with the same signals, and again outside the scope', async () => {
    const spy = spyOn(markdown, 'parseExpanded')
    const [, file, text] = SOURCES[1]!

    try {
      await inAnalysisScope(async () => {
        browserRole(text, file)
        browserRole(text, file)
        rendersAsIsland(text)
        browserRole(text, file, LIVE)
      })
      expect(spy).toHaveBeenCalledTimes(2)
      browserRole(text, file)
      browserRole(text, file)
      expect(spy).toHaveBeenCalledTimes(4)
    }
    finally {
      spy.mockRestore()
    }
  })
})
