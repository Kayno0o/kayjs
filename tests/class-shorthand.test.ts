import type { ElementNode, KayFile, Node, Span } from '../src/compiler/ast'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { plugin } from 'bun'
import tailwind from 'bun-plugin-tailwind'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { kay } from '../src/build/plugin'
import { compileKay } from '../src/compiler'
import { elementsIn } from '../src/compiler/ast'
import { isClassToken, scanClassName } from '../src/compiler/class-name'
import { formatKay } from '../src/compiler/format'
import { parseKay } from '../src/compiler/parser'
import { htmlToKay } from '../src/migrate/html'
import { modeOf, projectPaths, resolveProject } from '../src/project'
import { child } from '../src/runtime/html'
import { servePages } from '../src/server/app'
import { fixtureCopy, scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('class-shorthand-')
const MARKERS = /<!--[[\]]-->/g
const NOT_IDENTIFIER = /[^\w-]/g
const LEADING_DIGIT = /^(\d)/
const STYLE = /<style>([\s\S]*?)<\/style>/g
let cases = 0

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function elementsOf(nodes: Node[]): ElementNode[] {
  return [...elementsIn(nodes)]
}

// A class as a selector writes it, a leading digit as its hex escape.
function selector(name: string): string {
  return `.${name.replaceAll(NOT_IDENTIFIER, '\\$&').replace(LEADING_DIGIT, '\\3$1 ')}`
}

function slice(file: KayFile, span: Span): string {
  return file.source.slice(span.start, span.end)
}

// The classes of the first element, with no diagnostic allowed.
function classesOf(source: string): string[] {
  const file = parseKay(source)

  expect(file.diagnostics).toEqual([])

  return elementsOf(file.template)[0]!.classes.map(span => slice(file, span))
}

async function render(source: string): Promise<string> {
  const file = join(scratch, `case-${cases++}.kay`)

  await Bun.write(file, source)

  const module = await import(file) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default({})).replace(MARKERS, '')
}

describe('a Tailwind bracket in a shorthand class', () => {
  it.each([
    ['.bg-[#0a0a0a]', 'bg-[#0a0a0a]'],
    ['.[&>svg]:size-4', '[&>svg]:size-4'],
    ['.w-[calc(100%-2rem)]', 'w-[calc(100%-2rem)]'],
    ['.grid-cols-[1fr_2fr]', 'grid-cols-[1fr_2fr]'],
    ['.bg-[url(/a.png)]', 'bg-[url(/a.png)]'],
    ['.text-[1.5rem]', 'text-[1.5rem]'],
    ['.[&_svg:not([class*=\'size-\'])]:size-4', '[&_svg:not([class*=\'size-\'])]:size-4'],
    ['.[--my-var:1,2]', '[--my-var:1,2]'],
    ['.data-[state=open]:hover:bg-[color:var(--x)]/50', 'data-[state=open]:hover:bg-[color:var(--x)]/50'],
  ])('keeps %s as one class whatever it holds inside the brackets', (shorthand, expected) => {
    expect(classesOf(`div${shorthand} x\n`)).toEqual([expected])
    expect(classesOf(`${shorthand} x\n`)).toEqual([expected])
  })

  it('keeps a `#`, a `.`, a `(` and a `,` inside the brackets from opening an id, a class, attributes or a second class', () => {
    const file = parseKay('div.bg-[#0a0a0a].p-[1.5rem](id="a") x\n')
    const [div] = elementsOf(file.template)

    expect(file.diagnostics).toEqual([])
    expect(div!.classes.map(span => slice(file, span))).toEqual(['bg-[#0a0a0a]', 'p-[1.5rem]'])
    expect(div!.id).toBeUndefined()
    expect(div!.attributes).toHaveLength(1)
  })

  it('ends a class at a group followed by the things that follow a class', () => {
    const afterId = parseKay('div.bg-[#fff]#main x\n')

    expect(afterId.diagnostics).toEqual([])
    expect(slice(afterId, elementsOf(afterId.template)[0]!.id!)).toBe('main')
    expect(classesOf('div.w-[10px](id="a") x\n')).toEqual(['w-[10px]'])
    expect(classesOf('div.w-[10px] text (with) [brackets]\n')).toEqual(['w-[10px]'])
    expect(classesOf('ul.grid-cols-[1fr_2fr]: li x\n')).toEqual(['grid-cols-[1fr_2fr]'])
    expect(classesOf('ul.[&>li]:p-2: li x\n')).toEqual(['[&>li]:p-2'])
  })

  it('takes a class inside an inline tag, where a `]` closes the tag only outside a group', () => {
    const file = parseKay('p see #[a.bg-[red].[&>b]:underline(href="/x") link] now\n')
    const link = elementsOf(file.template).find(element => element.name === 'a')!

    expect(file.diagnostics).toEqual([])
    expect(link.classes.map(span => slice(file, span))).toEqual(['bg-[red]', '[&>b]:underline'])
    expect(link.attributes).toHaveLength(1)
  })

  it('takes the class of an `error` line', () => {
    const file = parseKay('error.[&>b]:text-sm.w-[1.5rem] title\n')

    expect(file.diagnostics).toEqual([])
    expect(file.template[0]).toMatchObject({ kind: 'error', name: 'title' })
  })

  it('takes the class of a component tag', () => {
    const file = parseKay('---\nimport Card from \'./card.kay\'\n---\nCard.[&>svg]:size-4.bg-(--brand) hi\n')
    const card = elementsOf(file.template)[0]!

    expect(file.diagnostics).toEqual([])
    expect(card.component).toBe(true)
    expect(card.classes.map(span => slice(file, span))).toEqual(['[&>svg]:size-4', 'bg-(--brand)'])
  })

  it('reports an unclosed `[` instead of splitting the class', () => {
    const source = 'div.bg-[#0a0a0a.p-2 x\n'
    const file = parseKay(source)

    expect(file.diagnostics.map(d => [source.slice(d.start, d.end), d.message])).toEqual([['[', 'Unclosed `[` in a class']])
    expect(file.diagnostics[0]!.help).toContain('`_`')
  })

  it('reports a `[` that a space ends, and one that the line ends', () => {
    expect(parseKay('div.w-[calc(1 + 2)] x\n').diagnostics.map(d => d.message)).toEqual(['Unclosed `[` in a class'])
    expect(parseKay('div.w-[1px\n').diagnostics.map(d => d.message)).toEqual(['Unclosed `[` in a class'])
    expect(parseKay('div.w-[[1px] x\n').diagnostics.map(d => d.message)).toEqual(['Unclosed `[` in a class'])
  })
})

describe('a variable group in a shorthand class', () => {
  it.each([
    ['.bg-(--brand)', 'bg-(--brand)'],
    ['.md:bg-(--brand)/50', 'md:bg-(--brand)/50'],
    ['.text-(length:--size)', 'text-(length:--size)'],
    ['.w-(--a,--b)', 'w-(--a,--b)'],
    ['.has-(>svg):p-1', 'has-(>svg):p-1'],
  ])('keeps %s as one class', (shorthand, expected) => {
    expect(classesOf(`div${shorthand} x\n`)).toEqual([expected])
  })

  it('still opens attributes at a `(` that follows no `-`', () => {
    const file = parseKay('a.btn.bg-(--brand)(href="/x" title="y") go\n')
    const [anchor] = elementsOf(file.template)

    expect(file.diagnostics).toEqual([])
    expect(anchor!.classes.map(span => slice(file, span))).toEqual(['btn', 'bg-(--brand)'])
    expect(anchor!.attributes).toHaveLength(2)
    expect(classesOf('a.btn(href="/x") go\n')).toEqual(['btn'])
  })

  it('reports an unclosed `-(`', () => {
    const source = 'div.bg-(--brand x\n'
    const file = parseKay(source)

    expect(file.diagnostics.map(d => [source.slice(d.start, d.end), d.message])).toEqual([['(', 'Unclosed `(` in a class']])
  })
})

describe('a `*` variant in a shorthand class', () => {
  it('is taken, one or two stars', () => {
    expect(classesOf('ul.*:p-2.**:underline.md:*:flex x\n')).toEqual(['*:p-2', '**:underline', 'md:*:flex'])
  })

  it('ends at a colon before a space like any variant, so a block expansion still opens', () => {
    const file = parseKay('ul.*: li x\n')

    expect(file.diagnostics).toEqual([])
    expect(elementsOf(file.template).map(element => element.name)).toEqual(['ul', 'li'])
  })
})

describe('a decimal beside a digit-led variant', () => {
  it('splits `2xl:` from a class ending in a digit', () => {
    expect(classesOf('div.col-2.2xl:flex x\n')).toEqual(['col-2', '2xl:flex'])
    expect(classesOf('div.w-1.5.2xl:block x\n')).toEqual(['w-1.5', '2xl:block'])
    expect(classesOf('div.p-2.3xl:p-4.4xl:p-8 x\n')).toEqual(['p-2', '3xl:p-4', '4xl:p-8'])
    expect(classesOf('div.col-2.2xl:flex(id="a") x\n')).toEqual(['col-2', '2xl:flex'])
  })

  it('keeps a decimal at the end of a class whatever follows it', () => {
    expect(classesOf('div.gap-1.5 x\n')).toEqual(['gap-1.5'])
    expect(classesOf('div.gap-1.25.p-2 x\n')).toEqual(['gap-1.25', 'p-2'])
    expect(classesOf('div.-mt-0.5!(id="a") x\n')).toEqual(['-mt-0.5!'])
    expect(classesOf('div.w-2.5/4 x\n')).toEqual(['w-2.5/4'])
    expect(classesOf('div.gap-1.5.2xl:gap-3 x\n')).toEqual(['gap-1.5', '2xl:gap-3'])
    expect(classesOf('ul.gap-1.5: li x\n')).toEqual(['gap-1.5'])
  })
})

describe('scanClassName and isClassToken', () => {
  it('end a class where the shorthand does', () => {
    expect(scanClassName('bg-[#fff].p-2', 0)).toEqual({ end: 9 })
    expect(scanClassName('p-2(x)', 0)).toEqual({ end: 3 })
    expect(scanClassName('x.bg-(--a)#id', 2)).toEqual({ end: 10 })
  })

  it('accept a token that reads back as the same class and refuse the rest', () => {
    for (const token of ['flex', 'md:w-[200px]', 'py-0.5', '[&>svg]:size-4', 'bg-(--brand)/50', '*:p-2', '2xl:block'])
      expect(isClassToken(token), token).toBe(true)

    for (const token of ['', 'a b', 'a.b', 'w-[1px', 'a(b)', 'bg-(--x', '#a', 'a,b', 'a=b', 'foo-', 'hover:', '5/6', '1.5'])
      expect(isClassToken(token), token).toBe(false)
  })
})

describe('the edges of the grammar', () => {
  it('reads a `(` after a `-` as a variable group, so a class ending in `-` takes no attribute list', () => {
    const file = parseKay('div.btn-(id="x") y\n')

    expect(file.diagnostics).toEqual([])
    expect(classesOf('div.btn-(id="x") y\n')).toEqual(['btn-(id="x")'])
    expect(parseKay('div.btn-(a="1" b="2") y\n').diagnostics.map(d => d.message)).toEqual(['Unclosed `(` in a class'])
  })

  it('ends a decimal at a letter, so `p-1.5em` is two classes', () => {
    expect(classesOf('div.p-1.5em x\n')).toEqual(['p-1', '5em'])
  })

  it('reads a quote after a letter or digit as an apostrophe, which pairs with nothing across the group', () => {
    expect(classesOf('div.x-[a\'].y-[b\'] z\n')).toEqual(['x-[a\']', 'y-[b\']'])
    expect(classesOf('div.content-[\'a_b\'].[&_[data-x=\'y\']]:p-2 z\n')).toEqual(['content-[\'a_b\']', '[&_[data-x=\'y\']]:p-2'])
    // The data URL keeps Tailwind, which scans this file for classes, from writing a url() Bun's CSS bundler would try to resolve.
    expect(classesOf(`div.bg-[url('data:,x')].font-[_"x"] z\n`)).toEqual([`bg-[url('data:,x')]`, 'font-[_"x"]'])
  })

  it('keeps a bracket inside quotes in the group, and renders the quotes', async () => {
    expect(classesOf('div.content-[\'[\'].content-["]"] x\n')).toEqual(['content-[\'[\']', 'content-["]"]'])
    expect(await render('div.[&_svg:not([class*=\'size-\'])]:p-1.content-["a"] x\n')).toBe('<div class="[&amp;_svg:not([class*=\'size-\'])]:p-1 content-[&quot;a&quot;]">x</div>')
  })
})

describe('the compiled classes', () => {
  const source = 'div.bg-[#0a0a0a].[&>svg]:size-4.w-[calc(100%-2rem)].bg-(--brand).md:bg-(--brand)/50.*:p-2.**:underline.gap-1.5.col-2.2xl:flex x\n'
  const expected = 'bg-[#0a0a0a] [&>svg]:size-4 w-[calc(100%-2rem)] bg-(--brand) md:bg-(--brand)/50 *:p-2 **:underline gap-1.5 col-2 2xl:flex'

  it('are one string on the server and in an island', () => {
    for (const output of ['html', 'dom'] as const) {
      const result = compileKay(source, 'x.kay', { output })

      expect(result.diagnostics, output).toEqual([])
      expect(result.tsx, output).toContain(expected.replace('[&>', '[&amp;>'))
    }
  })

  it('are collected for Tailwind as the words they are', () => {
    expect(compileKay(source, 'x.kay').classes).toEqual(expected.split(' '))
  })

  it('render in the class attribute with the characters HTML escapes', async () => {
    const html = await render(source)

    expect(html).toContain('class="bg-[#0a0a0a] [&amp;>svg]:size-4 w-[calc(100%-2rem)] bg-(--brand) md:bg-(--brand)/50 *:p-2 **:underline gap-1.5 col-2 2xl:flex"')
  })

  it('merge with a class attribute and a component prop', async () => {
    const html = await render('p.[&>b]:p-1(class="mt-[2px]") x\n')

    expect(html).toContain('class="[&amp;>b]:p-1 mt-[2px]"')
  })
})

describe('kay fmt', () => {
  it('keeps the classes it reads in the shorthand, as written', () => {
    const code = 'div.bg-[#0a0a0a].[&>svg]:size-4.bg-(--brand).*:p-2.gap-1.5.col-2.2xl:flex(id="a") x\n  span.w-[calc(100%-2rem)] y\n'

    expect(formatKay(code)).toEqual({ code, diagnostics: [] })
  })

  it('refuses a file with an unclosed group, as it does any file that does not parse', () => {
    expect(formatKay('div.w-[1px x\n').diagnostics.map(d => d.message)).toEqual(['Unclosed `[` in a class'])
  })
})

describe('kay fmt --from-html', () => {
  it('writes the Tailwind brackets, variables and star variants in the shorthand', () => {
    const { code, notes } = htmlToKay('<div class="bg-[#0a0a0a] [&>svg]:size-4 w-[calc(100%-2rem)] bg-(--brand) md:bg-(--brand)/50 *:p-2 **:underline col-2 2xl:flex">x</div>')

    expect(notes).toEqual([])
    expect(code).toBe('.bg-[#0a0a0a].[&>svg]:size-4.w-[calc(100%-2rem)].bg-(--brand).md:bg-(--brand)/50.*:p-2.**:underline.col-2.2xl:flex x\n')
    expect(parseKay(code).diagnostics).toEqual([])
    expect(classesOf(code)).toEqual(['bg-[#0a0a0a]', '[&>svg]:size-4', 'w-[calc(100%-2rem)]', 'bg-(--brand)', 'md:bg-(--brand)/50', '*:p-2', '**:underline', 'col-2', '2xl:flex'])
  })

  it('keeps a class the shorthand cannot hold in class="..."', () => {
    expect(htmlToKay('<div class="a w-[1px b(c) d">x</div>').code).toBe('.a.d(class="w-[1px b(c)") x\n')
  })

  it('keeps a class ending in a dash or a colon, or made of digits, out of the shorthand, whatever follows it', () => {
    expect(htmlToKay('<div class="foo-" data-a="1" title="t">x</div>').code).toBe('div(class="foo-" data-a="1" title="t") x\n')
    expect(htmlToKay('<div class="hover: y">x</div>').code).toBe('.y(class="hover:") x\n')
    expect(htmlToKay('<div class="w-1 5/6">x</div>').code).toBe('.w-1(class="5/6") x\n')
  })

  it('renders the same HTML as the page it read', async () => {
    const html = '<ul class="grid-cols-[1fr_2fr] [&>li]:p-2 bg-(--brand) col-2 2xl:flex"><li class="w-[calc(100%-2rem)]">x</li></ul>'

    expect(await render(htmlToKay(html).code)).toBe(html.replace('&>', '&amp;>'))
  })
})

describe('Tailwind', () => {
  const CLASSES = ['bg-[#0a0a0a]', '[&>svg]:size-4', 'w-[calc(100%-2rem)]', 'grid-cols-[1fr_2fr]', 'bg-(--brand)', 'md:bg-(--brand)/50', '*:p-2', '**:underline', 'gap-1.5', '2xl:block']
  let root = ''

  async function head(dir: string, built: Awaited<ReturnType<typeof buildClient>>, path: string): Promise<string> {
    const app = await servePages(resolveProject(dir, { routes: 'src/routes', compress: false }, modeOf({ dev: false, prebuilt: true })), () => ({ ...built, styles: new Map(built.styles), inlineStyles: undefined, inlineSizes: undefined, pageStyles: undefined }))
    const html = await (await app.handle(new Request(`http://localhost${path}`))).text()

    return [...html.matchAll(STYLE)].map(match => match[1]!).join('\n')
  }

  it('receives the classes of a shorthand through .kay/classes.txt and inlines their rules in the page', async () => {
    root = resolve(await fixtureCopy('page-styles'))

    try {
      await Bun.write(join(root, 'src/routes/brackets.kay'), `h1 Brackets\ndiv.${CLASSES.join('.')} x\n`)

      const built = await buildClient(root, { plugins: [tailwind] })
      const words = (await Bun.file(projectPaths(root).classes).text()).split('\n')
      const css = await head(root, built, '/brackets')

      for (const name of CLASSES) {
        expect(words, name).toContain(name)
        expect(css.includes(selector(name)), name).toBe(true)
      }
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
