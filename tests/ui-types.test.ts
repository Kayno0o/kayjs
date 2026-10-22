import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { check } from '../src/check'
import { fixtureCopy } from './scratch'

setDefaultTimeout(120_000)

const TILE = `---
import { recipe } from 'kay'

const tile = recipe({
  parts: { root: 'tile', head: 'p-2' },
  variants: { tone: { plain: {}, danger: { head: 'text-red-700' } }, compact: { true: 'p-1', false: '' } },
  defaults: { tone: 'plain' },
})
const { title } = props<{ title: string }>()
---
section
  header(part="head") {title}
`
const PANEL = 'section\n  div(part="body") a\n'
// A recipe with several top elements and no part marked, which has no part to restyle.
const LOOSE = `---\nimport { recipe } from 'kay'\n\nconst loose = recipe({ variants: { tone: { a: '', b: '' } } })\n---\np a\np b\n`
// Its own union beside the recipe, which an added value must not be narrowed back by.
const UNION = `---\nimport { recipe } from 'kay'\n\nconst union = recipe({ parts: { root: 'u' }, variants: { tone: { plain: '', danger: '' } } })\nconst { tone = 'plain' } = props<{ tone?: 'plain' | 'danger' }>()\n---\np(data-tone={tone}) a\n`
// A name kayjs-ui's Badge bears too.
const BADGE = 'span(part="root") a\n'

// A copy of the app fixture with three components and the given `src/ui.ts`; its `kay check` problems.
async function problems(ui: string, use = 'Tile(title="t")\nUnion\n'): Promise<string[]> {
  const root = resolve(await fixtureCopy('app'))

  try {
    await Promise.all([
      Bun.write(join(root, 'src/components/tile.kay'), TILE),
      Bun.write(join(root, 'src/panel.kay'), PANEL),
      Bun.write(join(root, 'src/badge.kay'), BADGE),
      Bun.write(join(root, 'src/loose.kay'), LOOSE),
      Bun.write(join(root, 'src/union.kay'), UNION),
      Bun.write(join(root, 'src/use.kay'), `---\nimport Tile from './components/tile.kay'\nimport Union from './union.kay'\n---\n${use}`),
      Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { '@kaynooo/kayjs-ui': '*', 'kay': '*' } })),
      Bun.write(join(root, 'src/ui.ts'), ui),
    ])

    return (await check(root)).map(problem => problem.message)
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('defineUi keys', () => {
  it('takes an app component and a kayjs-ui one by name, and by specifier', async () => {
    expect(await problems(`import { defineUi } from 'kay'

export default defineUi({
  Tile: { parts: { head: 'p-6' }, variants: { tone: { danger: { head: 'bg-red-100' } }, compact: { true: 'p-0' } } },
  Loose: { variants: { tone: { a: 'p-1' } } },
  './panel.kay': { parts: { body: 'p-4' } },
  Button: { parts: { root: 'rounded-xl' } },
})
`)).toEqual([])
  })

  it('reports a name no component bears, and one two bear with the specifiers that tell them apart', async () => {
    expect(await problems(`export default { Tille: { parts: 'p-2' }, Badge: { parts: 'p-2' } }`)).toEqual([
      '`Tille` names no component',
      '`Badge` names 2 components',
    ])
  })

  it('reports two keys naming one component, a name and a specifier', async () => {
    expect(await problems(`export default { Tile: { parts: 'p-2' }, './components/tile.kay': { parts: 'p-4' } }`)).toEqual([
      '`./components/tile.kay` names the same component as `Tile`',
    ])
  })
})

describe('defineUi types', () => {
  it.each([
    ['a part', 'Tile: { parts: { foot: \'p-6\' } }', 'foot'],
    ['a component', 'Tilee: { parts: \'p-2\' }', 'Tilee'],
  ])('fails on %s the component does not have', async (_, entry, word) => {
    const messages = await problems(`import { defineUi } from 'kay'\n\nexport default defineUi({ ${entry} })\n`)

    expect(messages.some(message => message.startsWith('Object literal') && message.includes(`'${word}'`))).toBe(true)
  })

  it('takes a value or a variant the component lacks', async () => {
    expect(await problems(`import { defineUi } from 'kay'\n\nexport default defineUi({ Tile: { variants: { tone: { brand: { head: 'x' } }, size: { sm: 'p-1' } } } })\n`)).toEqual([])
  })
})

describe('the props of a component src/ui.ts adds a value to', () => {
  const ui = (entry: string) => `import { defineUi } from 'kay'\n\nexport default defineUi({ ${entry} })\n`
  const use = 'Tile(title="t" tone="brand" size="sm")\nTile(title="t" tone="plain" compact)\nUnion(tone="brand")\n'

  it('include it at the call, whether the recipe or a union beside it declared the variant', async () => {
    expect(await problems(ui('Tile: { variants: { tone: { brand: \'x\' }, size: { sm: \'p-1\' } } }, Union: { variants: { tone: { brand: \'x\' } } }'), use)).toEqual([])
  })

  it('take a third value of a boolean variant and a numeric variant of their own', async () => {
    expect(await problems(ui('Tile: { variants: { compact: { auto: \'x\' }, cols: { 2: \'grid-cols-2\', 3: \'grid-cols-3\' } } }'), 'Tile(title="t" compact="auto" cols={2})\nTile(title="t" compact cols="3")\nUnion\n')).toEqual([])
  })

  it('stay the recipe\'s alone otherwise', async () => {
    const messages = await problems(ui('Tile: { parts: \'x\' }'), use)

    expect(messages.filter(message => message.includes('"brand"'))).toHaveLength(2)
  })
})
