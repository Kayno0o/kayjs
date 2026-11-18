import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { iconSlotsOf, registryWith } from '../src/build/icon-slots'
import { scratchDir } from './scratch'

const UI = join(import.meta.dir, '../packages/ui/src')

describe('registryWith', () => {
  it('keeps the entries of the slots and the imports they read', () => {
    const out = registryWith(readFileSync(join(UI, 'defaults.ts'), 'utf8'), new Set(['close', 'delete']))

    expect(out).toContain('icons: { close, delete: remove }')
    expect(out).toContain('~icons/tabler/x\'')
    expect(out).toContain('~icons/tabler/trash\'')
    expect(out).not.toContain('~icons/tabler/search')
  })

  it('cuts the slots added later as well', () => {
    const out = registryWith(readFileSync(join(UI, 'added-icons.ts'), 'utf8'), new Set(['trendUp']))

    expect(out).toContain('= { trendUp }')
    expect(out).not.toContain('tabler/bell')
  })

  it('leaves a module whose registry is written another way as it is', () => {
    const source = 'export const addedIcons = {\n  a,\n}\n'

    expect(registryWith(source, new Set())).toBe(source)
  })
})

describe('iconSlotsOf', () => {
  async function project(files: Record<string, string>): Promise<string[]> {
    const root = await scratchDir('icon-slots-')

    await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(root, name), text)))

    return [root, ...Object.keys(files).map(name => join(root, name))]
  }

  it('reads the slots written as strings in the files an island reaches', async () => {
    const [root, island] = await project({ 'island.kay': '---\nimport Other from \'./other.kay\'\n---\nOther\nButton(icon="close")\n', 'other.kay': 'Icon(icon={flag ? \'search\' : \'plus\'})\n', 'unreached.kay': 'Icon(icon="star")\n' })
    const slots = await iconSlotsOf(root!, [island!], [])

    expect([...slots!].filter(word => ['close', 'search', 'plus', 'star'].includes(word)).sort()).toEqual(['close', 'plus', 'search'])
  })

  it('answers undefined when the project names a slot from a variable', async () => {
    const [root, island] = await project({ 'island.kay': '---\nconst name = props<{ name: string }>().name\n---\nIcon(icon={name})\n' })

    expect(await iconSlotsOf(root!, [island!], [])).toBeUndefined()
  })

  it('takes an icon imported from a set for no slot', async () => {
    const [root, island] = await project({ 'island.kay': '---\nimport Home from \'~icons/tabler/home\'\n---\nIcon(icon={Home})\n' })

    expect(await iconSlotsOf(root!, [island!], [])).toBeDefined()
  })
})
