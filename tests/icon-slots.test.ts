import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { iconSlotsOf, isUiRegistry, registryWith, slotsKey } from '../src/build/icon-slots'
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

// A stand-in for kayjs-ui's Icon, which the slots are only trusted with when it was followed.
const uiIcon = (root: string): string => join(root, 'packages/ui/src/icon.kay')

describe('iconSlotsOf', () => {
  async function project(files: Record<string, string>): Promise<string[]> {
    const root = await scratchDir('icon-slots-')

    await Bun.write(uiIcon(root), 'svg\n')
    await Promise.all(Object.entries(files).map(async ([name, text]) => Bun.write(join(root, name), text)))

    return [root, ...Object.keys(files).map(name => join(root, name))]
  }

  it('reads the slots written as strings in the files an island reaches', async () => {
    const [root, island] = await project({ 'island.kay': '---\nimport Other from \'./other.kay\'\n---\nOther\nButton(icon="close")\n', 'other.kay': 'Icon(icon={flag ? \'search\' : \'plus\'})\n', 'unreached.kay': 'Icon(icon="star")\n' })
    const slots = await iconSlotsOf(root!, [uiIcon(root!), island!], [])

    expect([...slots!].filter(word => ['close', 'search', 'plus', 'star'].includes(word)).sort()).toEqual(['close', 'plus', 'search'])
  })

  it('answers undefined when the project names a slot from a variable', async () => {
    const [root, island] = await project({ 'island.kay': '---\nconst name = props<{ name: string }>().name\n---\nIcon(icon={name})\n' })

    expect(await iconSlotsOf(root!, [uiIcon(root!), island!], [])).toBeUndefined()
  })

  it('takes an icon imported from a set for no slot', async () => {
    const [root, island] = await project({ 'island.kay': '---\nimport Home from \'~icons/tabler/home\'\n---\nIcon(icon={Home})\n' })

    expect(await iconSlotsOf(root!, [uiIcon(root!), island!], [])).toBeDefined()
  })

  it.each([
    ['a template literal', 'Icon(icon={`trend${d}`})'],
    ['a choice with a variable', 'Icon(icon={d ? \'search\' : name})'],
    ['a prop of a sibling', 'Menu(items={[{ label: x, icon: item.icon }]})'],
    ['a prop of another name', 'Stat(openIcon={name})'],
  ])('answers undefined for %s', async (_name, template) => {
    const [root, island] = await project({ 'island.kay': `${template}\n` })

    expect(await iconSlotsOf(root!, [uiIcon(root!), island!], [])).toBeUndefined()
  })

  it('reads a choice of two slots, and a page the island does not import', async () => {
    const [root, island, page] = await project({ 'island.kay': 'Icon(icon={open ? \'close\' : \'menu\'})\n', 'page.kay': 'Menu(items={[{ label: \'x\', icon: \'edit\' }]})\n' })
    const slots = await iconSlotsOf(root!, [uiIcon(root!), island!, page!], [])

    expect(slots?.has('edit')).toBe(true)
    expect(slots?.has('menu')).toBe(true)
  })

  it('answers undefined when kayjs-ui was not followed', async () => {
    const [root, island] = await project({ 'island.kay': 'Button(icon="close")\n' })

    expect(await iconSlotsOf(root!, [island!], [])).toBeUndefined()
  })

  it('takes a type annotation for no variable', async () => {
    const [root, island] = await project({ 'island.ts': 'export interface Item { icon: IconSlot, other?: string }\nexport const a = { icon: \'close\' }\n' })

    expect(await iconSlotsOf(root!, [uiIcon(root!), island!], [])).toBeDefined()
  })
})

describe('the registry of kayjs-ui', () => {
  it('is recognised by the package that holds it, and an app\'s own packages/ui is not', async () => {
    const root = await scratchDir('icon-registry-')

    await Bun.write(join(root, 'packages/ui/package.json'), '{"name":"app-ui"}')
    await Bun.write(join(root, 'packages/ui/src/defaults.ts'), '')

    expect(isUiRegistry(join(UI, 'defaults.ts'))).toBe(true)
    expect(isUiRegistry(join(root, 'packages/ui/src/defaults.ts'))).toBe(false)
  })

  it('keys no slots apart from the whole registry', () => {
    expect(slotsKey(new Set())).not.toBe(slotsKey(undefined))
  })
})
