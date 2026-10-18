import type { UnresolvedClass } from '../src/build/style-uses'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { expandInline, styleUses } from '../src/build/style-uses'
import { scratchDir } from './scratch'

const CSS = '.mt-1{margin-top:1px}.p-1{padding:1px}.btn-primary{color:red}.md\\:flex{display:flex}'

// The classes the page at `source` names, as the class attribute writes them.
async function namedBy(source: string): Promise<string[]> {
  const root = await scratchDir('style-uses-')
  const page = join(root, 'page.kay')

  await Bun.write(page, source)

  const { classes, entries } = styleUses(root, [page], [CSS], { edges: new Map(), open: new Set() }, new Map())
  const used = entries['page.kay'] as number[]

  return used.map(index => classes[index]!).sort()
}

describe('which classes a page names', () => {
  it('reads a class written whole, and the start or the end of one built at runtime', async () => {
    expect(await namedBy('p.mt-1 hello\n')).toEqual(['mt-1'])
    expect(await namedBy('p(class={`btn-${kind}`}) hello\n')).toEqual(['btn-primary'])
    expect(await namedBy('p(class={`${screen}:flex`}) hello\n')).toEqual(['md:flex'])
  })

  it('does not take a number such as the -1 of a comparison for the end of a class', async () => {
    expect(await namedBy('--- server\nconst found = [1].indexOf(1) !== -1\n---\np hello\n')).toEqual([])
  })
})

describe('which classes a page rendering Markdown names', () => {
  it('takes in the words of the files writing markup, but not text in a code block or span', async () => {
    const root = await scratchDir('style-uses-open-')
    const page = join(root, 'page.kay')
    const plugin = join(root, 'plugin.ts')
    const notes = join(root, 'notes.md')

    await Bun.write(page, 'p.mt-1 hello\n')
    await Bun.write(plugin, 'export const html = \'<i class="p-1"></i>\'\n')
    await Bun.write(notes, 'Hello <b class="btn-primary">a</b> `md:flex`\n\n```html\n<i class="mt-1 md:flex"></i>\n```\n')

    const named = (open: boolean) => {
      const { classes, entries } = styleUses(root, [page], [CSS], { edges: new Map(), open: new Set(open ? [page] : []) }, new Map(), [plugin, notes])

      return (entries['page.kay'] as number[]).map(index => classes[index]!).sort()
    }

    expect(named(false)).toEqual(['mt-1'])
    expect(named(true)).toEqual(['btn-primary', 'mt-1', 'p-1'])
  })
})

describe('which Markdown counts as code', () => {
  it.each([
    ['a tilde fence', '~~~\n<i class="p-1"></i>\n~~~\n', []],
    ['a fence closed by a longer one', '```\n<i class="p-1"></i>\n`````\n', []],
    ['a fence never closed', '```\n<i class="p-1"></i>\n', ['p-1']],
    ['a line of inline code that opens like a fence', '```x``` <i class="p-1"></i>\n', ['p-1']],
  ])('reads %s', async (_name, markdown, expected) => {
    const root = await scratchDir('style-uses-md-')
    const page = join(root, 'page.kay')
    const notes = join(root, 'notes.md')

    await Bun.write(page, 'p hello\n')
    await Bun.write(notes, markdown)

    const { classes, entries } = styleUses(root, [page], [CSS], { edges: new Map(), open: new Set([page]) }, new Map(), [notes])

    expect((entries['page.kay'] as number[]).map(index => classes[index]!)).toEqual(expected)
  })
})

describe('which classes `@source inline` keeps', () => {
  it('expands braces, alternatives and numeric ranges as Tailwind does', () => {
    expect(expandInline('underline')).toEqual(['underline'])
    expect(expandInline('{hover:,focus:}bg-red-{50,{100..300..100},950}').toSorted()).toEqual(['focus:bg-red-100', 'focus:bg-red-200', 'focus:bg-red-300', 'focus:bg-red-50', 'focus:bg-red-950', 'hover:bg-red-100', 'hover:bg-red-200', 'hover:bg-red-300', 'hover:bg-red-50', 'hover:bg-red-950'])
    expect(expandInline('p-{3..1}')).toEqual(['p-3', 'p-2', 'p-1'])
    expect(expandInline('{a,b')).toEqual(['{a,b'])
  })

  it('puts the styled ones on every page, whichever file lists them', async () => {
    const root = await scratchDir('style-uses-inline-')
    const first = join(root, 'first.kay')
    const second = join(root, 'second.kay')
    const css = join(root, 'app.css')

    await Bun.write(first, 'p.mt-1 hello\n')
    await Bun.write(second, 'p hello\n')
    await Bun.write(css, '@import "tailwindcss";\n@source inline("btn-{primary,gone}");\n@source not inline("p-1");\n')

    const { classes, entries } = styleUses(root, [first, second], [CSS], { edges: new Map([[first, [css]]]), open: new Set() }, new Map())
    const named = (page: string) => (entries[page] as number[]).map(index => classes[index]!).sort()

    // Only the class the stylesheets style counts, and a `not inline` leaves its class out.
    expect(named('first.kay')).toEqual(['btn-primary', 'mt-1'])
    expect(named('second.kay')).toEqual(['btn-primary'])
  })
})

describe('which classes are set from a value the build cannot read', () => {
  async function unresolved(source: string, css = '', file = 'island.ts'): Promise<string[]> {
    const root = await scratchDir('style-uses-runtime-')
    const page = join(root, file)
    const sheet = join(root, 'app.css')
    const found: UnresolvedClass[] = []

    await Bun.write(page, source)
    await Bun.write(sheet, css)
    styleUses(root, [page], [CSS], { edges: new Map([[page, [sheet]]]), open: new Set() }, new Map(), [], { own: () => true, unresolved: (all) => {
      found.push(...all)
    } })

    return found.map(({ line, how, part }) => `${line} ${how} ${part}`)
  }

  it('finds a class added, assigned or attributed from a value of the script', async () => {
    expect(await unresolved('el.classList.add(tone)\nel.className = tone\nel.setAttribute(\'class\', tone)\n')).toEqual(['1 classList.add ', '2 className = ', '3 setAttribute(\'class\') '])
    expect(await unresolved('el.classList.toggle(\'mt-1\', on)\nel.className = on ? \'p-1\' : \'mt-1\'\nel.classList.add(...(on ? [\'p-1\'] : []))\nel.classList.add(...tones)\n')).toEqual(['4 classList.add '])
  })

  it('keeps quiet when the start of the name completes to a styled class, or the app listed some', async () => {
    expect(await unresolved('el.classList.add(`btn-${kind}`)\n')).toEqual([])
    expect(await unresolved('el.className = \'tone-\' + kind\n')).toEqual(['1 className = tone-'])
    expect(await unresolved('el.classList.add(tone)\n', '@source inline("btn-primary");')).toEqual([])
    expect(await unresolved('el.className = \'tone-\' + kind\n', '@source inline("btn-primary");')).toEqual(['1 className = tone-'])
    expect(await unresolved('el.className = \'tone-\' + kind\n', '@source inline("tone-{a,b}");')).toEqual([])
  })

  it('judges a class attribute by what its value is made of', async () => {
    // A prop is named by the component using this one, a `btn-` fragment completes, a class written out is read as it is.
    expect(await unresolved('const { tone } = props<{ tone: string }>()\n---\np(class={tone}) a\np(class={`card ${props.class}`}) b\np(class={`btn-${kind}`}) c\np(class={on ? \'p-1\' : \'mt-1\'}) d\n', '', 'page.kay')).toEqual([])
    expect(await unresolved('const tone = on ? \'p-1\' : \'mt-1\'\n---\np(class={tone}) a\n', '', 'page.kay')).toEqual([])
    expect(await unresolved('const { shade: tone } = props<{ shade: string }>()\n---\np(class={tone}) a\n', '', 'page.kay')).toEqual([])
  })

  it('finds a class attribute a server builds from a value, a bare one included', async () => {
    expect(await unresolved('p(class={tone}) a\n', '', 'page.kay')).toEqual(['1 class attribute '])
    expect(await unresolved('const tone = [\'ring\', 4].join(\'-\')\n---\np(class={tone}) a\n', '', 'page.kay')).toEqual(['3 class attribute '])
    expect(await unresolved('const type = kinds[0]\n---\naside(class={`callout ${type}`}) a\n', '', 'page.kay')).toEqual(['3 class attribute callout ${}'])
    expect(await unresolved('p(class={`tone-${kind}`}) c\n', '', 'page.kay')).toEqual(['1 class attribute tone-${}'])
    expect(await unresolved('p(class={tone}) a\n', '@source inline("btn-primary");', 'page.kay')).toEqual([])
  })

  it('tells the expression, whether a file runs in the browser, and the entries reaching it', async () => {
    const root = await scratchDir('style-uses-runtime-')
    const page = join(root, 'page.kay')
    const island = join(root, 'island.kay')
    const found: UnresolvedClass[] = []

    await Bun.write(page, 'p(class={tone}) a\n')
    await Bun.write(island, 'p(class={shade(on)}) b\n')
    styleUses(root, [page], [CSS], { edges: new Map([[page, [island]]]), open: new Set() }, new Map(), [], { own: () => true, islands: [island], unresolved: (all) => {
      found.push(...all)
    } })
    expect(found.map(({ file, expression, client, by }) => [relative(root, file), expression, client, by.map(entry => relative(root, entry))])).toEqual([['page.kay', 'tone', false, ['page.kay']], ['island.kay', 'shade(on)', true, ['page.kay']]])
  })

  it('leaves out files that are not the app\'s', async () => {
    const root = await scratchDir('style-uses-lib-')
    const page = join(root, 'page.ts')
    const found: unknown[] = []

    await Bun.write(page, 'el.classList.add(tone)\n')
    styleUses(root, [page], [CSS], { edges: new Map(), open: new Set() }, new Map(), [], { own: () => false, unresolved: (all) => {
      found.push(...all)
    } })
    expect(found).toEqual([])
  })
})
