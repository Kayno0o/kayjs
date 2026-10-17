import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { styleUses } from '../src/build/style-uses'
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
