import type { ElementNode, ForNode, IfNode, KayFile, Node, Span, TextNode } from '../src/compiler/ast'
import { describe, expect, it } from 'bun:test'
import { parseKay } from '../src/compiler/parser'

function parse(source: string): KayFile {
  return parseKay(source)
}

function text(file: KayFile, span: Span | undefined): string | undefined {
  return span && file.source.slice(span.start, span.end)
}

function element(node: Node | undefined): ElementNode {
  if (node?.kind !== 'element')
    throw new Error(`expected an element, got ${node?.kind}`)

  return node
}

// Renders the tree compactly so a test reads like the template it parsed.
function outline(file: KayFile, nodes: Node[] = file.template): unknown[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case 'element':
        return {
          tag: node.name,
          ...(node.classes.length > 0 && { classes: node.classes.map(span => text(file, span)) }),
          ...(node.id && { id: text(file, node.id) }),
          ...(node.attributes.length > 0 && { attributes: node.attributes.map(attribute => attribute.kind === 'spread' ? `...${text(file, attribute.expression)}` : `${text(file, attribute.name)}:${attribute.kind === 'static' ? attribute.text : attribute.kind === 'expression' ? `{${text(file, attribute.expression)}}` : true}`) }),
          ...(node.children.length > 0 && { children: outline(file, node.children) }),
        }
      case 'text':
        return node.parts.map(part => part.kind === 'chunk' ? part.text : part.kind === 'expression' ? `{${text(file, part.expression)}}` : outline(file, [part])[0])
      case 'if':
        return { if: node.branches.map(branch => ({ test: text(file, branch.test), alias: text(file, branch.alias), children: outline(file, branch.children) })) }
      case 'for':
        return { for: text(file, node.item), index: text(file, node.index), of: text(file, node.each), key: text(file, node.key), children: outline(file, node.children), fallback: node.fallback && outline(file, node.fallback) }
      case 'await':
        return { await: text(file, node.value), pending: outline(file, node.pending), resolved: node.resolved && { alias: text(file, node.resolved.alias), children: outline(file, node.resolved.children) }, rejected: node.rejected && { alias: text(file, node.rejected.alias), children: outline(file, node.rejected.children) } }
      case 'slot':
        return { slot: text(file, node.name), children: outline(file, node.children) }
    }

    return node
  })
}

describe('fence', () => {
  it('splits the script from the template', () => {
    const file = parse('---\nconst a = 1\n---\np hi\n')

    expect(text(file, file.script)).toBe('const a = 1\n')
    expect(outline(file)).toEqual([{ tag: 'p', children: [['hi']] }])
    expect(file.diagnostics).toEqual([])
  })

  it('accepts a template without a script', () => {
    const file = parse('p hi')

    expect(file.script).toBeUndefined()
    expect(outline(file)).toEqual([{ tag: 'p', children: [['hi']] }])
  })

  it('reports an unclosed fence', () => {
    expect(parse('---\nconst a = 1\n').diagnostics[0]?.message).toContain('never closed')
  })

  it('names a fence kind spelled with capitals or without a space as unknown', () => {
    expect(parse('--- Server\nconst a = 1\n---\np hi').diagnostics[0]?.message).toContain('Unknown fence `--- Server`')
    expect(parse('---server\nconst a = 1\n---\np hi').diagnostics[0]?.message).toContain('Unknown fence `---server`')
  })
})

describe('elements', () => {
  it('reads shorthand classes and id, with div implied', () => {
    const file = parse('.card#main.wide\nsection.a.b')

    expect(outline(file)).toEqual([
      { tag: 'div', classes: ['card', 'wide'], id: 'main' },
      { tag: 'section', classes: ['a', 'b'] },
    ])
  })

  it('keeps Tailwind variants and fractions in the shorthand', () => {
    const file = parse('div.flex.md:grid.w-1/2.hover:bg-red-500')

    expect(element(file.template[0]).classes.map(span => text(file, span))).toEqual(['flex', 'md:grid', 'w-1/2', 'hover:bg-red-500'])
  })

  it('nests by indentation', () => {
    const file = parse('ul\n  li one\n  li two\np after')

    expect(outline(file)).toEqual([
      { tag: 'ul', children: [{ tag: 'li', children: [['one']] }, { tag: 'li', children: [['two']] }] },
      { tag: 'p', children: [['after']] },
    ])
  })

  it('reads static, expression, boolean and spread attributes across lines', () => {
    const file = parse('input(\n  type="text"\n  value={name()}, disabled\n  {...rest}\n  onInput={e => set({ v: e.currentTarget.value })}\n)')

    expect(outline(file)).toEqual([{ tag: 'input', attributes: ['type:text', 'value:{name()}', 'disabled:true', '...rest', 'onInput:{e => set({ v: e.currentTarget.value })}'] }])
    expect(file.diagnostics).toEqual([])
  })

  it('skips braces inside strings and template literals of an expression', () => {
    const file = parse('a(href={`/t/${id()}?q={x}`} title={"}"})')

    expect(outline(file)).toEqual([{ tag: 'a', attributes: ['href:{`/t/${id()}?q={x}`}', 'title:{"}"}'] }])
    expect(file.diagnostics).toEqual([])
  })

  it('marks capitalized tags as components', () => {
    const file = parse('TodoItem(todo={t})')

    expect(element(file.template[0]).component).toBe(true)
  })

  it('expands `tag: child` and attaches indented children to the innermost element', () => {
    const file = parse('li: a(href="/") Home\n  span.badge new')

    expect(outline(file)).toEqual([
      { tag: 'li', children: [{ tag: 'a', attributes: ['href:/'], children: [['Home'], { tag: 'span', classes: ['badge'], children: [['new']] }] }] },
    ])
  })

  it('rejects text glued to a tag', () => {
    expect(parse('p.x=oops').diagnostics.length).toBeGreaterThan(0)
  })
})

describe('text', () => {
  it('interpolates expressions and keeps escapes literal', () => {
    const file = parse('p Hello {user().name}, \\{not code}!')

    expect(outline(file)).toEqual([{ tag: 'p', children: [['Hello ', '{user().name}', ', {not code}!']] }])
  })

  it('reads piped text and inline tags', () => {
    const file = parse('p\n  | Read the #[a(href="/docs") docs] first.\n  | Then go.')

    expect(outline(file)).toEqual([{
      tag: 'p',
      children: [
        ['Read the ', { tag: 'a', attributes: ['href:/docs'], children: [['docs']] }, ' first.'],
        ['Then go.'],
      ],
    }])
  })

  it('reads spaces left after a tag as no text, and keeps those that follow text', () => {
    const file = parse('ul    \n  li {x}  \np Hello \n  b world')

    expect(outline(file)).toEqual([{ tag: 'ul', children: [{ tag: 'li', children: [['{x}', '  ']] }] }, { tag: 'p', children: [['Hello '], { tag: 'b', children: [['world']] }] }])
  })

  it('drops comments with their indented block', () => {
    const file = parse('// note\n  p hidden\np shown')

    expect(outline(file)).toEqual([{ tag: 'p', children: [['shown']] }])
  })
})

describe('control flow', () => {
  it('chains if, else if and else', () => {
    const file = parse('if a()\n  p a\nelse if b()\n  p b\nelse\n  p c')
    const node = file.template[0] as IfNode

    expect(node.branches.map(branch => text(file, branch.test))).toEqual(['a()', 'b()', undefined])
    expect(file.diagnostics).toEqual([])
  })

  it('reads a narrowing alias but leaves type keywords alone', () => {
    const file = parse('if user() as u\n  p {u.name}\nif x as const\n  p y')

    expect(outline(file)).toMatchObject([
      { if: [{ test: 'user()', alias: 'u' }] },
      { if: [{ test: 'x as const', alias: undefined }] },
    ])
  })

  it('reads for with index, key and an else fallback', () => {
    const file = parse('for todo, i of todos().filter(t => t.open) key={todo.id}\n  li {todo.title}\nelse\n  li.empty none')
    const node = file.template[0] as ForNode

    expect(text(file, node.item)).toBe('todo')
    expect(text(file, node.index)).toBe('i')
    expect(text(file, node.each)).toBe('todos().filter(t => t.open)')
    expect(text(file, node.key)).toBe('todo.id')
    expect(node.fallback).toHaveLength(1)
    expect(file.diagnostics).toEqual([])
  })

  it('requires a key on for', () => {
    expect(parse('for t of list\n  li x').diagnostics[0]?.message).toContain('needs a key')
  })

  it('rejects a stray else', () => {
    expect(parse('p a\nelse\n  p b').diagnostics[0]?.message).toContain('must directly follow')
  })

  it('reads an if on the line after else as a child of the else, not as else if', () => {
    const file = parse('if a\n  p x\nelse\n  if b\n    p y\n  p z\n')
    const node = file.template[0] as IfNode

    expect(node.branches).toHaveLength(2)
    expect(text(file, node.branches[1]?.test)).toBeUndefined()
    expect(node.branches[1]?.children.map(child => child.kind)).toEqual(['if', 'element'])

    const loop = parse('for x of xs key={x}\n  p x\nelse\n  if b\n    p y\n').template[0] as ForNode

    expect(loop.fallback?.map(child => child.kind)).toEqual(['if'])
    expect(parse('if a\n  p x\nelse\t if b\n  p y').diagnostics).toEqual([])
  })

  it('keeps a regex literal with brackets and quotes inside an expression whole', () => {
    expect(outline(parse('a(x={/\\)/.test(y)} z="1") hi'))).toEqual([{ tag: 'a', attributes: ['x:{/\\)/.test(y)}', 'z:1'], children: [['hi']] }])
    expect(outline(parse('p {s.replace(/\\//g, "-")} after'))).toEqual([{ tag: 'p', children: [[`{s.replace(/\\//g, "-")}`, ' after']] }])
    expect(outline(parse('p {/}/.test(s)} after'))).toEqual([{ tag: 'p', children: [['{/}/.test(s)}', ' after']] }])
    expect(outline(parse('p {s.split(/[(/]/).length} after'))).toEqual([{ tag: 'p', children: [['{s.split(/[(/]/).length}', ' after']] }])
    expect(outline(parse('a(x={a / b} y={c / d}) t'))).toEqual([{ tag: 'a', attributes: ['x:{a / b}', 'y:{c / d}'], children: [['t']] }])
    expect(outline(parse('if /[(]/.test(x)\n  p'))).toMatchObject([{ if: [{ test: '/[(]/.test(x)' }] }])
    expect(outline(parse('for a of s.split(/\\//) key={a}\n  p'))).toMatchObject([{ for: 'a', of: 's.split(/\\//)', key: 'a' }])
    expect(parse('for a of s.split(/\'/) key={a}\n  p').diagnostics).toEqual([])
  })

  it('requires the head of a for on one line', () => {
    expect(parse('ul\n  for todo of todos\n\nkey={todo.id}\n    li x\n').diagnostics.length).toBeGreaterThan(0)
    expect(parse('for todo of\n  todos key={todo.id}\n  p').diagnostics.length).toBeGreaterThan(0)
    expect(parse('for todo of todos\n  key={todo.id}\n  p').diagnostics[0]?.message).toContain('needs a key')
  })

  it('reads await with its pending, then and catch blocks', () => {
    const file = parse('await comments(post.id)\n  p wait\nthen list\n  p {list.length}\ncatch error\n  p oops\nawait user then\n  p ready\np after')

    expect(outline(file)).toEqual([
      { await: 'comments(post.id)', pending: [{ tag: 'p', children: [['wait']] }], resolved: { alias: 'list', children: [{ tag: 'p', children: [['{list.length}']] }] }, rejected: { alias: 'error', children: [{ tag: 'p', children: [['oops']] }] } },
      { await: 'user', pending: [], resolved: { alias: undefined, children: [{ tag: 'p', children: [['ready']] }] }, rejected: undefined },
      { tag: 'p', children: [['after']] },
    ])
    expect(file.diagnostics).toEqual([])
  })

  it('requires then after await and rejects a stray then or catch', () => {
    expect(parse('await x\n  p wait\np after').diagnostics[0]?.message).toContain('needs a `then` block')
    expect(parse('p a\nthen x').diagnostics[0]?.message).toContain('`then` must directly follow an `await`')
    expect(parse('await x\n  p\ncatch e\n  p').diagnostics.map(d => d.message)).toContain('`catch` must directly follow the `then` of an `await` at the same indentation')
    expect(parse('await x then a\n  p\nthen b\n  p').diagnostics[0]?.message).toContain('`then` must directly follow')
  })

  it('reads slots under a component', () => {
    const file = parse('Loading\n  @fallback\n    p wait\n  p ready')

    expect(outline(file)).toEqual([{ tag: 'Loading', children: [{ slot: 'fallback', children: [{ tag: 'p', children: [['wait']] }] }, { tag: 'p', children: [['ready']] }] }])
  })
})

describe('diagnostics', () => {
  it('reports inconsistent indentation and tabs', () => {
    const messages = parse('ul\n    li a\n  li b\n\tli c').diagnostics.map(d => d.message)

    expect(messages.some(m => m.includes('Inconsistent indentation'))).toBe(true)
    expect(messages.some(m => m.includes('tabs'))).toBe(true)
  })

  it('points spans at the offending source', () => {
    const file = parse('p(class=foo)')
    const diagnostic = file.diagnostics[0]!

    expect(file.source.slice(diagnostic.start, diagnostic.end)).toBe('class=')
  })

  it('keeps node spans on the source they came from', () => {
    const file = parse('---\nconst x = 1\n---\nsection\n  p {x}\n')
    const section = element(file.template[0])

    expect(file.source.slice(section.start, section.end)).toBe('section\n  p {x}')
    const text = element(section.children[0]).children[0] as TextNode

    expect(text.parts[0]?.kind).toBe('expression')
  })

  it('closes a static attribute string on the line it opens, reporting an unclosed one at its opening quote', () => {
    const source = 'div\n  a(href="/x) hi\n  p(title="t") z\n'
    const diagnostic = parse(source).diagnostics.find(d => d.message === 'Unclosed string')!

    expect(source.slice(diagnostic.start, diagnostic.end)).toBe('"')
    expect(diagnostic.start).toBe(source.indexOf('"'))
    expect(parse('a(title="a\n  b" c="1") x').diagnostics.map(d => d.message)).toContain('Unclosed string')
  })

  it('reports tabs in the lines under a comment', () => {
    expect(parse('a\n  // c\n\t\t\tp\n  e').diagnostics.map(d => d.message)).toContain('Indent with spaces, not tabs')
  })

  it('reports an unterminated template literal in an if, for or await expression', () => {
    for (const source of ['if `\n  p x\n', 'for a of `x key={a}\n  p', 'await `x\n  p\nthen\n  p'])
      expect(parse(source).diagnostics.map(d => d.message)).toContain('Unclosed template literal')
  })
})
