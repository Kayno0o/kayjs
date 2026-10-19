import type { ElementNode } from '../src/compiler/ast'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { plugin } from 'bun'
import { afterAll, describe, expect, it } from 'bun:test'
import { kay } from '../src/build/plugin'
import { compileKay } from '../src/compiler'
import { elementsIn } from '../src/compiler/ast'
import { formatKay } from '../src/compiler/format'
import { parseKay } from '../src/compiler/parser'
import { child } from '../src/runtime/html'
import { scratchDir } from './scratch'

await plugin(kay())

const scratch = await scratchDir('attribute-shorthand-')
const MARKERS = /<!--[[\]]-->/g
let cases = 0

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function elementsOf(source: string): { elements: ElementNode[], messages: string[] } {
  const file = parseKay(source)

  return { elements: [...elementsIn(file.template)], messages: file.diagnostics.map(d => d.message) }
}

async function render(source: string): Promise<string> {
  const file = join(scratch, `case-${cases++}.kay`)

  await Bun.write(file, source)

  const module = await import(file) as { default: (props: Record<string, unknown>) => unknown }

  return child(module.default({})).replace(MARKERS, '')
}

// The generated code of a template, and of the same template with its shorthand written out, for every output.
function sameAsWrittenOut(shorthand: string, written: string, head = '---\nconst title = \'T\'\nconst rest = { id: \'r\' }\n---\n') {
  for (const options of [{}, { check: true }, { output: 'dom' as const }, { output: 'html' as const }, { includeServer: true }, { output: 'dom' as const, island: true }]) {
    const short = compileKay(`${head}${shorthand}\n`, 'src/main.kay', options)
    const long = compileKay(`${head}${written}\n`, 'src/main.kay', options)

    expect(short.diagnostics.map(d => d.message)).toEqual(long.diagnostics.map(d => d.message))
    expect(short.tsx).toBe(long.tsx)
  }
}

describe('a bare {name} in an attribute list', () => {
  it('means name={name}, on an element and on a component', () => {
    const { elements, messages } = elementsOf('---\nimport Card from \'./card.kay\'\n---\nimg({src} alt="x" {title})\nCard({title} {href})\n')

    expect(messages).toEqual([])
    expect(elements.map(element => element.attributes.map(attribute => attribute.kind === 'spread' ? '...' : attribute.kind))).toEqual([['expression', 'static', 'expression'], ['expression', 'expression']])
  })

  it('reads the one name as the attribute and as its value, whitespace around it ignored', () => {
    const source = 'p({ title })\n'
    const file = parseKay(source)
    const attribute = [...elementsIn(file.template)][0]!.attributes[0]!

    expect(file.diagnostics).toEqual([])
    expect(attribute).toMatchObject({ kind: 'expression', shorthand: { start: 2, end: 11 } })

    if (attribute.kind === 'expression')
      expect([source.slice(attribute.name.start, attribute.name.end), source.slice(attribute.expression.start, attribute.expression.end)]).toEqual(['title', 'title'])
  })

  it('compiles to what the written-out form does, in every output, a spread before or after it keeping its order of overrides', () => {
    sameAsWrittenOut('a({title} href="/")', 'a(title={title} href="/")')
    sameAsWrittenOut('a({title} {...rest})', 'a(title={title} {...rest})')
    sameAsWrittenOut('a({...rest} {title})', 'a({...rest} title={title})')
    sameAsWrittenOut('a({...rest} {title} {...rest})', 'a({...rest} title={title} {...rest})')
    sameAsWrittenOut('a(\n  {title}\n  href="/"\n  {...rest}\n)', 'a(\n  title={title}\n  href="/"\n  {...rest}\n)')
  })

  it('merges {style} with the shorthand and a class attribute with the written-out value', () => {
    sameAsWrittenOut('p.a(style="x" {title})', 'p.a(style="x" title={title})')
    sameAsWrittenOut('p.a({style})', 'p.a(style={style})', '---\nconst style = \'color: red\'\n---\n')
    sameAsWrittenOut('p.a({id})', 'p.a(id={id})', '---\nconst id = \'x\'\n---\n')
  })

  it('attaches a handler, passes a ref and a boolean, as the written-out form does', () => {
    sameAsWrittenOut('button({onClick} {disabled}) x', 'button(onClick={onClick} disabled={disabled}) x', '---\nimport { signal } from \'kay\'\n\nconst disabled = signal(false)\nconst onClick = () => disabled.set(true)\n---\n')
    sameAsWrittenOut('input({ref} {disabled})', 'input(ref={ref} disabled={disabled})', '---\nlet ref: HTMLInputElement | undefined\nconst disabled = false\n---\n')
    sameAsWrittenOut('button({disabled}) x', 'button(disabled={disabled}) x', '---\nconst disabled = true\n---\n')
  })

  it('keeps the name of a destructured prop a component forwards', () => {
    sameAsWrittenOut('a({title} {href})', 'a(title={title} href={href})', '---\nconst { title, href } = props<{ title: string, href: string }>()\n---\n')
    sameAsWrittenOut('a({title})', 'a(title={title})', '---\nconst { title = \'T\' } = props<{ title?: string }>()\n---\n')
  })

  it('hands a signal whole to a component and reads it in a value, as the written-out form does', () => {
    sameAsWrittenOut('Toggle({open})', 'Toggle(open={open})', '---\nimport { signal } from \'kay\'\nimport Toggle from \'./toggle.kay\'\n\nconst open = signal(false)\n---\n')
    sameAsWrittenOut('p({open}) x', 'p(open={open}) x', '---\nimport { signal } from \'kay\'\n\nconst open = signal(false)\n---\n')
  })

  it('writes the attribute out in the fix of a lint on its name, so the braces never hold more than a name', () => {
    const fixed = (source: string, code: string) => {
      const result = compileKay(source, 'src/main.kay', { check: true }).diagnostics.find(diagnostic => diagnostic.code === code || diagnostic.message.includes(code))
      const edit = result!.fixes![0]!.edits[0]!

      return `${source.slice(0, edit.start)}${edit.text}${source.slice(edit.end)}`
    }

    expect(fixed('---\nimport { signal } from \'kay\'\n\nconst title = signal(\'a\')\n---\np({ title }) x\n', 'uncalled-signal')).toBe('---\nimport { signal } from \'kay\'\n\nconst title = signal(\'a\')\n---\np(title={title()}) x\n')
    expect(fixed('---\nconst onclick = () => {}\n---\nbutton({onclick}) x\n', 'does not attach')).toBe('---\nconst onclick = () => {}\n---\nbutton(onClick={onclick}) x\n')
    expect(fixed('---\nconst onclick = () => {}\n---\nbutton(id="a" {onclick}) x\n', 'does not attach')).toBe('---\nconst onclick = () => {}\n---\nbutton(id="a" onClick={onclick}) x\n')
  })

  it('renders the value of the variable on the server', async () => {
    expect(await render('---\nconst title = \'A < B\'\nconst disabled = true\nconst href = \'/x\'\n---\na({href} {title} {disabled}) go\n')).toBe('<a href="/x" title="A &lt; B" disabled>go</a>')
  })

  it('renders a component prop and lets a later one override an earlier spread', async () => {
    await Bun.write(join(scratch, 'card.kay'), '---\nconst { title, href } = props<{ title: string, href: string }>()\n---\na({href}) {title}\n')

    expect(await render('---\nimport Card from \'./card.kay\'\nconst title = \'Hi\'\nconst href = \'/h\'\nconst rest = { href: \'/other\' }\n---\nCard({title} {...rest} {href})\n')).toBe('<a href="/h">Hi</a>')
    expect(await render('---\nimport Card from \'./card.kay\'\nconst title = \'Hi\'\nconst href = \'/h\'\nconst rest = { href: \'/other\' }\n---\nCard({title} {href} {...rest})\n')).toBe('<a href="/other">Hi</a>')
  })

  it.each([
    ['p({post.title})', 'A braced attribute is the name of a variable, or a spread', '`title={post.title}`'],
    ['p({post?.title})', 'A braced attribute is the name of a variable, or a spread', '`title={post?.title}`'],
    ['p({x()})', 'A braced attribute is the name of a variable, or a spread', '`name={expression}`, or `{...props}`'],
    ['p({a + b})', 'A braced attribute is the name of a variable, or a spread', '`name={expression}`, or `{...props}`'],
    ['p({aria-label})', 'A braced attribute is the name of a variable, or a spread', '`name={expression}`, or `{...props}`'],
    ['p({class})', '`class` is a reserved word, so no variable has that name', '`class={value}`'],
    ['p({for})', '`for` is a reserved word, so no variable has that name', '`for={value}`'],
  ])('reports %s with the written-out form rather than a guess', (source, message, help) => {
    const file = parseKay(`${source}\n`)

    expect(file.diagnostics.map(d => [d.message, d.help])).toEqual([[message, help]])
    expect(`${source}\n`.slice(file.diagnostics[0]!.start, file.diagnostics[0]!.end)).toBe(source.slice(2, -1))
  })

  it('reports an empty pair of braces and goes on to the next attribute', () => {
    const file = parseKay('p({} id="a")\n')

    expect(file.diagnostics).toHaveLength(1)
    expect(elementsOf('p({} id="a")\n').elements[0]!.attributes).toHaveLength(2)
  })

  it('keeps a spread working', () => {
    expect(elementsOf('p({...rest} { ...more })\n')).toMatchObject({ messages: [] })
  })

  it('is kept by kay fmt, lines of several attributes included', () => {
    expect(formatKay('a({ title }   href="/" {...rest})\n').code).toBe('a({title} href="/" {...rest})\n')
    expect(formatKay('a(\n  {title}\n  {href}\n)\n').code).toBe('a(\n  {title}\n  {href}\n)\n')
  })
})
