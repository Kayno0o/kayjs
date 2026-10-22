import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { buildClassTable, contextOf, declaredProperties } from '../src/build/class-table'
import { installClassTable, resolveClasses } from '../src/runtime/class-table'
import { classText } from '../src/runtime/values'
import { scratchDir } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  installClassTable(undefined)
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(css: string): Promise<string> {
  const dir = await scratchDir('class-table-')

  dirs.push(dir)
  await Bun.write(join(dir, 'src', 'app.css'), css)

  return dir
}

const WORDS = ['p-4', 'p-6', 'px-4', 'py-2', 'hover:p-2', 'hover:p-4', '!p-2', '-mt-2', 'mt-2', 'mt-4', 'p-[3px]', 'p-[5px]', 'flex', 'hidden', 'block', 'text-sm', 'text-lg', 'text-red-500', 'text-blue-500', 'bg-red-500', 'bg-[image:var(--hero)]', 'size-4', 'w-4', 'h-4', 'shadow-md', 'shadow-lg', 'ring-2', 'border', 'border-2', 'border-t-2', 'border-red-500', 'rounded', 'rounded-t-lg', 'md:p-4', 'md:p-6', 'card', 'btn-primary', 'group', 'tab-4', 'tab-8', 'uppercase', 'font-bold', 'font-medium', '*:p-2', 'bg-brand', 'bg-red-500/50', 'gap-2', 'gap-x-4', 'inset-0', 'top-0', 'bg-(--brand)', 'place-items-center', 'items-start', 'place-content-center', 'content-start', 'col-span-2', 'col-start-1', 'ms-2', 'space-x-4', 'space-y-4', 'divide-x']

describe('declaredProperties', () => {
  it('reads the properties of a rule, nested variants included, and skips @property blocks', () => {
    expect(declaredProperties('.hover\\:p-2 { &:hover { @media (hover: hover) { padding: 0.5rem; } } }')).toEqual(['padding'])
    expect(declaredProperties('.shadow { --tw-shadow: 0 1px #000; box-shadow: var(--tw-shadow); } @property --tw-shadow { syntax: "*"; inherits: false; }')).toEqual(['--tw-shadow', 'box-shadow'])
    expect(declaredProperties('.x { background-image: url(data:image/png;base64,AA); content: "a;b{"; }')).toEqual(['background-image', 'content'])
  })
})

describe('contextOf', () => {
  it('is the variants and importance of a class', () => {
    expect(contextOf('p-4')).toBe('')
    expect(contextOf('hover:p-4')).toBe('hover:')
    expect(contextOf('md:hover:p-4')).toBe('md:hover:')
    expect(contextOf('!p-4')).toBe('!')
    expect(contextOf('p-4!')).toBe('!')
    expect(contextOf('[&>svg]:size-4')).toBe('[&>svg]:')
    expect(contextOf('bg-[image:var(--hero)]')).toBe('')
  })
})

describe('the class table', () => {
  let table: Awaited<ReturnType<typeof buildClassTable>>

  beforeEach(async () => {
    table ??= await buildClassTable(await project('@import "tailwindcss";\n@theme { --color-brand: #c00; }\n@utility tab-* { tab-size: --value(integer); }\n'), WORDS, [])
    installClassTable(table)
  })

  const merge = (...parts: string[]) => classText(parts)

  it('is built from the app\'s Tailwind and holds only classes that can meet another', () => {
    expect(table).toBeDefined()
    expect(table!.classes['p-4']).toBeDefined()
    expect(table!.classes.card).toBeUndefined()
    expect(table!.classes.group).toBeUndefined()
    expect(table!.classes.uppercase).toBeUndefined()
  })

  it('is built for an app importing only Tailwind\'s theme and utilities', async () => {
    const parts = await buildClassTable(await project('@import "tailwindcss/theme.css" layer(theme);\n@import "tailwindcss/utilities.css" layer(utilities);\n'), WORDS, [])

    expect(parts?.classes['p-4']).toBeDefined()
  })

  it('has none without Tailwind', async () => {
    expect(await buildClassTable(await project('body { margin: 0 }\n'), WORDS, [])).toBeUndefined()
  })

  it('lets the later class win', () => {
    expect(merge('p-4', 'p-6')).toBe('p-6')
    expect(merge('p-4 text-sm', 'p-6')).toBe('text-sm p-6')
    expect(merge('flex', 'hidden')).toBe('hidden')
    expect(merge('mt-4', '-mt-2')).toBe('-mt-2')
    expect(merge('p-4', 'p-[3px]')).toBe('p-[3px]')
    expect(merge('tab-4', 'tab-8')).toBe('tab-8')
    expect(merge('bg-red-500', 'bg-brand')).toBe('bg-brand')
    expect(merge('bg-red-500', 'bg-(--brand)')).toBe('bg-(--brand)')
    expect(merge('text-sm', 'text-lg')).toBe('text-lg')
  })

  it('drops a class a shorthand later covers, and keeps both the other way', () => {
    expect(merge('px-4', 'p-6')).toBe('p-6')
    expect(merge('p-6', 'px-4')).toBe('p-6 px-4')
    expect(merge('border-t-2', 'border-2')).toBe('border-2')
    expect(merge('border-2', 'border-t-2')).toBe('border-2 border-t-2')
    expect(merge('w-4 h-4', 'size-4')).toBe('size-4')
    expect(merge('size-4', 'w-4')).toBe('size-4 w-4')
    expect(merge('gap-x-4', 'gap-2')).toBe('gap-2')
    expect(merge('top-0', 'inset-0')).toBe('inset-0')
  })

  it('keeps classes under other variants or importance', () => {
    expect(merge('p-4', 'hover:p-2')).toBe('p-4 hover:p-2')
    expect(merge('hover:p-4', 'hover:p-2')).toBe('hover:p-2')
    expect(merge('md:p-4', 'p-6')).toBe('md:p-4 p-6')
    expect(merge('md:p-4', 'md:p-6')).toBe('md:p-6')
    expect(merge('!p-2', 'p-4')).toBe('!p-2 p-4')
    expect(merge('p-4', '!p-2')).toBe('p-4 !p-2')
    expect(merge('p-4', '*:p-2')).toBe('p-4 *:p-2')
  })

  it('keeps classes setting different properties', () => {
    expect(merge('text-sm', 'text-red-500')).toBe('text-sm text-red-500')
    expect(merge('bg-red-500', 'bg-[image:var(--hero)]')).toBe('bg-red-500 bg-[image:var(--hero)]')
    expect(merge('shadow-md', 'ring-2')).toBe('shadow-md ring-2')
    expect(merge('font-bold uppercase', 'font-medium')).toBe('uppercase font-medium')
    expect(merge('rounded', 'rounded-t-lg')).toBe('rounded rounded-t-lg')
  })

  it('lets a place-* shorthand and a grid span override what they cover', () => {
    expect(merge('items-start', 'place-items-center')).toBe('place-items-center')
    expect(merge('content-start', 'place-content-center')).toBe('place-content-center')
    expect(merge('col-start-1', 'col-span-2')).toBe('col-span-2')
    expect(merge('col-span-2', 'col-start-1')).toBe('col-span-2 col-start-1')
  })

  it('keeps a class whose utility spaces the element\'s children', () => {
    expect(merge('ms-2', 'space-x-4')).toBe('ms-2 space-x-4')
    expect(merge('space-x-4', 'space-y-4')).toBe('space-x-4 space-y-4')
  })

  it('lets shadows override each other', () => {
    expect(merge('shadow-md', 'shadow-lg')).toBe('shadow-lg')
  })

  it('leaves classes the table does not hold as they are, in place', () => {
    expect(merge('card p-4', 'btn-primary p-6')).toBe('card btn-primary p-6')
    expect(merge('constructor p-4', '__proto__ p-6')).toBe('constructor __proto__ p-6')
    expect(merge('p-${size} p-4', 'p-6')).toBe('p-${size} p-6')
  })

  it('merges every source of an array, objects and nested arrays included', () => {
    expect(classText(['p-4 text-sm', { 'p-6': true, 'flex': false }, ['text-lg']])).toBe('p-6 text-lg')
    expect(classText(['px-4', undefined, null, false, ''])).toBe('px-4')
  })

  it('resolves a plain string only when asked, as a lone string is one source', () => {
    expect(classText('p-4 p-6')).toBe('p-4 p-6')
    expect(resolveClasses('p-4 p-6')).toBe('p-6')
    expect(resolveClasses('p-4')).toBe('p-4')
  })

  it('merges as before without a table', () => {
    installClassTable(undefined)
    expect(merge('p-4', 'p-6')).toBe('p-4 p-6')
  })
})
