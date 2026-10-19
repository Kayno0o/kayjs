import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { compileKay } from '../src/compiler'
import { formatKay } from '../src/compiler/format'
import { parseKay } from '../src/compiler/parser'
import { htmlToKay } from '../src/migrate/html'
import { child } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('class-wrap-')
const MARKERS = /<!--[[\]]-->/g
let cases = 0

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function format(source: string): string {
  const { code, diagnostics } = formatKay(source)

  expect(diagnostics).toEqual([])
  expect(formatKay(code).code).toBe(code)

  return code
}

async function render(source: string): Promise<string> {
  const file = join(scratch, `case-${cases++}.kay`)

  await Bun.write(file, source)

  const module = await import(file) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default({})).replace(MARKERS, '')
}

// A shorthand of `count` classes named c01, c02 and so on, each four characters long with its dot.
const classes = (count: number) => Array.from({ length: count }, (_, index) => `.c${String(index + 1).padStart(2, '0')}`).join('')

describe('a static class over several lines', () => {
  const source = 'div(class="\n  flex  items-center\n  gap-1.5 [&>svg]:size-4\n") x\n'

  it('parses, and joins its words with single spaces', () => {
    const file = parseKay(source)

    expect(file.diagnostics).toEqual([])
    expect(file.template[0]).toMatchObject({ kind: 'element', attributes: [{ kind: 'static', text: 'flex items-center gap-1.5 [&>svg]:size-4' }] })
  })

  it('renders as one class string on the server and in an island', () => {
    for (const output of ['html', 'dom'] as const) {
      const { tsx, diagnostics } = compileKay(source, 'x.kay', { output })

      expect(diagnostics, output).toEqual([])
      expect(tsx, output).toContain('class=\\"flex items-center gap-1.5 [&amp;>svg]:size-4\\"')
    }
  })

  it('merges with the shorthand, a spread and an expression beside it as one class', async () => {
    expect(await render('div.a(class="\n  b\n  c\n") x\n')).toBe('<div class="a b c">x</div>')
    expect(await render('---\nconst props = { class: \'d\', id: \'i\' }\n---\ndiv.a(class="\n  b\n  c\n" {...props}) x\n')).toBe('<div id="i" class="a b c d">x</div>')
  })

  it('still reports a string that never closes', () => {
    expect(parseKay('div(class="a b) x\n').diagnostics.map(d => d.message)).toContain('Unclosed string')
    expect(parseKay('div(title="a\nb") x\n').diagnostics.map(d => d.message)).toContain('Unclosed string')
  })

  it('reports a class quote forgotten on its line at once, not at a quote many lines below', () => {
    const file = parseKay('div(class="a b) x\np(title="t") y\n')

    expect(file.diagnostics.map(d => d.message)).toContain('Unclosed string')
    expect(file.diagnostics[0]).toMatchObject({ start: 10 })
  })

  it('reads a value that starts on its next line with a carriage return, and keeps a no-break space inside a word', () => {
    const crlf = parseKay('div(class="\r\n  a\r\n  b\r\n") x\n')

    expect(crlf.diagnostics).toEqual([])
    expect(crlf.template[0]).toMatchObject({ attributes: [{ text: 'a b' }] })
    expect(parseKay('div(class="\n  a\u00A0b c\n") x\n').template[0]).toMatchObject({ attributes: [{ text: 'a\u00A0b c' }] })
  })

  it('keeps its lines when kay fmt runs', () => {
    const code = '  div(\n    class="\n      flex items-center\n      gap-1\n    "\n    id="a"\n  ) x\n'

    expect(format(`div\n${code}`)).toBe(`div\n${code}`)
  })
})

describe('kay fmt on an element whose classes make its line long', () => {
  it('leaves a line of up to 120 characters in the shorthand and moves one of 121', () => {
    // The element is `dl`, 29 classes of 4 characters and the last one: 120 with `.z`, 121 with `.zz`.
    const fits = `dl${classes(29)}.z x\n`

    expect(format(fits)).toBe(fits)
    expect(format(`dl${classes(29)}.zz x\n`)).toStartWith('dl(\n  class="')
  })

  it('moves the shorthand into a class attribute inside parentheses, its value over lines when it is too long for one', () => {
    const words = Array.from({ length: 30 }, (_, index) => `c${String(index + 1).padStart(2, '0')}`)

    expect(format(`div${classes(30)} x\n`)).toBe(`div(\n  class="\n    ${words.slice(0, 29).join(' ')}\n    c30\n  "\n) x\n`)
  })

  it('keeps the value on one line when it fits, which other attributes in the head make possible', () => {
    const href = `/${'a'.repeat(60)}`
    const words = Array.from({ length: 15 }, (_, index) => `c${String(index + 1).padStart(2, '0')}`).join(' ')

    expect(format(`a${classes(15)}(href="${href}") go\n`)).toBe(`a(\n  class="${words}"\n  href="${href}"\n) go\n`)
  })

  it('leaves a single short class alone when the other attributes make the line long', () => {
    const line = `img.brand(src={logo} width={large() ? 64 : 16} alt="Brand" role="button" tabindex="0" onClick={() => large.set(on => !on)})\n`

    expect(line.length).toBeGreaterThan(120)
    expect(format(line)).toBe(line)
  })

  it('moves a static class that makes the line long, and keeps the order of a spread before it', () => {
    const list = Array.from({ length: 30 }, (_, index) => `c${String(index + 1).padStart(2, '0')}`).join(' ')
    const before = `div.a({...props} class="${list}") x\n`
    const after = `div.a(class="${list}" {...props}) x\n`

    expect(format(before)).toBe(before)
    expect(format(after)).toStartWith('div(\n  class="\n    a c01')
    expect(format(after)).toEndWith('\n  "\n  {...props}\n) x\n')
  })

  it('leaves an element alone when its attributes alone make the line long', () => {
    const long = `input.title(aria-label="Title" onInput={async kayEvent => draft({ title: kayEvent.currentTarget.value, published: true, tags: [] })})\n`

    expect(format(long)).toBe(long)
  })

  it('counts the indentation and what comes before the element on its line', () => {
    const fits = `div${classes(27)}.z` // 3 + 108 + 2 = 113, plus 4 for the indentation = 117

    expect(format(`ul\n  li\n    ${fits}\n`)).toBe(`ul\n  li\n    ${fits}\n`)
    expect(format(`ul\n  li\n    ${fits}.z.z\n`)).toContain('    div(\n      class="\n')
    expect(format(`p.c01.c02: ${fits}.z.z.z\n`)).toContain('p.c01.c02: div(\n  class="\n')
  })

  it('wraps a class value that is too long for one line between class=" and "', () => {
    const code = format(`section${classes(60)} x\n`)
    const lines = code.split('\n')

    expect(lines.slice(0, 2)).toEqual(['section(', '  class="'])
    expect(lines.at(-3)).toBe('  "')
    expect(lines.at(-2)).toBe(') x')
    expect(lines.every(line => line.length <= 120)).toBe(true)
    expect(lines.slice(2, -3).join(' ').split(' ').filter(Boolean)).toHaveLength(60)
    expect(lines.slice(2, -3).every(line => line.startsWith('    c'))).toBe(true)
  })

  it('keeps the id, the other attributes and the text', () => {
    const code = format(`a${classes(30)}#top(href="/x"   target="_blank") go\n`)

    expect(code).toStartWith('a#top(\n  class="\n    c01 c02')
    expect(code).toEndWith('\n  "\n  href="/x"\n  target="_blank"\n) go\n')
  })

  it('writes a div for an element that is only classes', () => {
    expect(format(`${classes(30)}#top x\n`)).toStartWith('div#top(\n  class="\n    c01 c02')
  })

  it('merges with a static class attribute, the shorthand first', () => {
    const code = format(`div${classes(30)}(class="last  words" id="a") x\n`)

    expect(code).toContain('c30 last words\n  "\n  id="a"\n) x\n')
  })

  it('moves the classes of a component too', () => {
    expect(format(`Card${classes(30)}(open) x\n`)).toStartWith('Card(\n  class="\n    c01 c02')
  })

  it('leaves alone an element with class={...}, attributes already over lines, or inside a text', () => {
    const expression = `div${classes(30)}(class={tone}) x\n`
    const spread = `div${classes(30)}(\n  id="a"\n  title="b"\n) x\n`
    const inline = `p see #[a${classes(30)}(href="/x") link] now\n`

    expect(format(expression)).toBe(expression)
    expect(format(spread)).toBe(spread)
    expect(format(inline)).toBe(inline)
  })

  it('leaves a long line alone when it is long for its text, not its classes', () => {
    const text = `p.a ${'word '.repeat(40)}end\n`

    expect(format(text)).toBe(text)
  })

  it('renders the same HTML before and after', async () => {
    const source = `div${classes(30)}#top(class="tail" title="t") Hello {1 + 1}\n`

    expect(await render(format(source))).toBe(await render(source))
    expect(await render(format(`section${classes(60)} x\n`))).toBe(await render(`section${classes(60)} x\n`))
  })

  it('keeps Tailwind brackets, variables and decimals whole', () => {
    const tailwind = Array.from({ length: 12 }).fill('.[&>svg]:size-4.w-[calc(100%-2rem)].bg-(--brand)/50.gap-1.5').join('')
    const code = format(`div${tailwind} x\n`)

    expect(code).toContain('    [&>svg]:size-4 w-[calc(100%-2rem)] bg-(--brand)/50 gap-1.5 ')
    expect(parseKay(code).diagnostics).toEqual([])
  })
})

describe('kay fmt --from-html on a long class list', () => {
  it('writes the classes inside parentheses, one attribute to a line', () => {
    const list = Array.from({ length: 30 }, (_, index) => `utility-${index}`).join(' ')
    const { code } = htmlToKay(`<div class="${list}" id="a"><a href="/x" class="b">go</a></div>`)

    expect(code).toStartWith('div#a(\n  class="\n    utility-0 utility-1')
    expect(code).toContain('\n  a.b(href="/x") go\n')
    expect(formatKay(code).code).toBe(code)
  })
})
