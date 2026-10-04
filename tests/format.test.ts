import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { findKayFiles } from '../src/build/files'
import { formatFiles, formatKay } from '../src/format'

const fixtures = join(import.meta.dir, 'fixtures')

function format(source: string): string {
  const { code, diagnostics } = formatKay(source)

  expect(diagnostics).toEqual([])
  expect(formatKay(code).code).toBe(code)

  return code
}

describe('formatKay', () => {
  it('re-indents the template two spaces a level, keeping comments and dropping the spaces after a tag, of blank lines and extra blank lines', () => {
    const source = [
      '',
      '---   server',
      'const open = 1',
      '---',
      '',
      'ul    ',
      '    // rows',
      '    for todo of todos key={todo.id}',
      '        li {todo.title}',
      '    else',
      '        li Nothing',
      '   ',
      '',
      '',
      'p {open} open',
      '',
    ].join('\n')

    expect(format(source)).toBe([
      '--- server',
      'const open = 1',
      '---',
      'ul',
      '  // rows',
      '  for todo of todos key={todo.id}',
      '    li {todo.title}',
      '  else',
      '    li Nothing',
      '',
      'p {open} open',
      '',
    ].join('\n'))
  })

  it('keeps the type parameters of a generic component on its fence line', () => {
    expect(formatKay('---<T extends { id: number }>  \nconst { items } = props<{ items: T[] }>()\n---\np {items.length}\n').code).toBe('--- <T extends { id: number }>\nconst { items } = props<{ items: T[] }>()\n---\np {items.length}\n')
  })

  it('writes attribute lists canonically, inline ones included', () => {
    expect(format('a( href = \'/x\' ,  disabled {...rest} title=\'say "hi"\' onClick={() => go( 1 )} )\np Hi #[b( x=\'1\' ) there]\n'))
      .toBe('a(href="/x" disabled {...rest} title=\'say "hi"\' onClick={() => go( 1 )})\np Hi #[b(x="1") there]\n')
  })

  it('spreads a multi-line attribute list one attribute per line, its closing paren back at the element', () => {
    const source = ['div', '    form(', '          action={add}', '       method="post")', '        input(name="title")', ''].join('\n')

    expect(format(source)).toBe(['div', '  form(', '    action={add}', '    method="post"', '  )', '    input(name="title")', ''].join('\n'))
  })

  it('shifts an attribute whose value spans lines instead of rewriting it', () => {
    const source = ['div', '    button(onClick={() => {', '      go()', '    }}) Go', ''].join('\n')

    expect(format(source)).toBe(['div', '  button(onClick={() => {', '    go()', '  }}) Go', ''].join('\n'))
  })

  it('keeps the lines of a multi-line template literal byte for byte', () => {
    const source = ['div', '    p {`  ', '    x  ', '  y`}', ''].join('\n')

    expect(format(source)).toBe(['div', '  p {`  ', '    x  ', '  y`}', ''].join('\n'))
  })

  it('keeps fence code as written, template literals and blank lines included', () => {
    const source = ['---', '', 'const text = `a  ', '', '', 'b`', '', '---', 'p {text}', ''].join('\n')

    expect(format(source)).toBe(['---', 'const text = `a  ', '', '', 'b`', '---', 'p {text}', ''].join('\n'))
  })

  it('keeps a `---` line inside a template literal in the fence, as in a markdown front matter', () => {
    const source = ['--- server', 'const md = `---', 'title: x', '---', 'body`', '---', 'p {md}', ''].join('\n')

    expect(format(source)).toBe(source)
  })

  it('keeps the trailing whitespace of text, which renders, and trims only blank lines', () => {
    expect(format('p Hello \n  b world\n  \n| tail  \n')).toBe('p Hello \n  b world\n\n| tail  \n')
    expect(format('p {\n  a\n} x  \n')).toBe('p {\n  a\n} x  \n')
  })

  it('keeps the parameters of a slot as written, shifting the lines they span', () => {
    expect(format('List\n    @row({ id }, i)\n        li {id}\n')).toBe('List\n  @row({ id }, i)\n    li {id}\n')
    expect(format('List\n    @row(\n      todo,\n    )\n        li x\n')).toBe('List\n  @row(\n    todo,\n  )\n    li x\n')
  })

  it('keeps the braces of a multi-line key with the for, so children stay under it', () => {
    expect(format('ul\n  for todo of todos key={todo.id\n\n}\n    li x\n')).toBe('ul\n  for todo of todos key={todo.id\n\n}\n    li x\n')
  })

  it('leaves a file whose attribute string spans lines as an error rather than mangling it', () => {
    const { code, diagnostics } = formatKay('div\n    a(title="a   \n  b" c="1") x\n')

    expect(code).toBe('div\n    a(title="a   \n  b" c="1") x\n')
    expect(diagnostics.map(d => d.message)).toContain('Unclosed string')
  })

  it('normalizes CRLF line endings', () => {
    expect(format('ul\r\n    li One\r\n')).toBe('ul\n  li One\n')
  })

  it('leaves a file that does not parse untouched and reports why', () => {
    const source = 'ul\n  for item of items\n    li {item}\n'
    const { code, diagnostics } = formatKay(source)

    expect(code).toBe(source)
    expect(diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('`for` needs a key') })])
  })

  it('leaves every fixture unchanged', async () => {
    const files = await findKayFiles(fixtures)

    expect(files.length).toBeGreaterThan(10)
    await Promise.all(files.map(async (file) => {
      const source = await Bun.file(file).text()

      expect({ file, code: formatKay(source).code }).toEqual({ file, code: source })
    }))
  })
})

describe('formatFiles', () => {
  it('lists unformatted files without touching them in check mode, and rewrites them otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-fmt-'))
    const file = join(dir, 'page.kay')

    try {
      await Bun.write(file, 'ul\n    li One\n')
      await Bun.write(join(dir, 'clean.kay'), 'p Hi\n')

      expect(await formatFiles([dir], { write: false })).toEqual({ changed: [file], errors: [] })
      expect(await Bun.file(file).text()).toBe('ul\n    li One\n')

      expect(await formatFiles([dir], { write: true })).toEqual({ changed: [file], errors: [] })
      expect(await Bun.file(file).text()).toBe('ul\n  li One\n')
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('formatFiles, explicit paths', () => {
  it('throws before writing when a path is missing or not a .kay file, and skips a directory named dist only at a project root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-fmt-'))

    try {
      await Bun.write(join(dir, 'package.json'), '{}')
      await Bun.write(join(dir, 'notes.txt'), 'ul\n    li One\n')
      await Bun.write(join(dir, 'page.kay'), 'ul\n    li One\n')
      await Bun.write(join(dir, 'src/dist/inner.kay'), 'ul\n    li One\n')
      await Bun.write(join(dir, 'dist/out.kay'), 'ul\n    li One\n')

      await expect(formatFiles([join(dir, 'page.kay'), join(dir, 'notes.txt')], { write: true })).rejects.toThrow('notes.txt is not a .kay file')
      await expect(formatFiles([join(dir, 'nope.kay')], { write: true })).rejects.toThrow('nope.kay does not exist')
      expect(await Bun.file(join(dir, 'notes.txt')).text()).toBe('ul\n    li One\n')
      expect(await Bun.file(join(dir, 'page.kay')).text()).toBe('ul\n    li One\n')
      expect((await formatFiles([dir], { write: false })).changed).toEqual([join(dir, 'page.kay'), join(dir, 'src/dist/inner.kay')])
      expect((await formatFiles([join(dir, 'src')], { write: false })).changed).toEqual([join(dir, 'src/dist/inner.kay')])
      expect((await formatFiles([dir, join(dir, 'page.kay'), `${dir}/./page.kay`], { write: false })).changed).toEqual([join(dir, 'page.kay'), join(dir, 'src/dist/inner.kay')])
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
