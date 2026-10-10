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
      case 'try':
        return { try: outline(file, node.children), rejected: node.rejected && { alias: text(file, node.rejected.alias), children: outline(file, node.rejected.children) } }
      case 'slot':
        return { slot: text(file, node.name), ...(node.params && { params: text(file, node.params) }), children: outline(file, node.children) }
      case 'const':
        return { const: text(file, node.pattern), value: text(file, node.value) }
      case 'error':
        return { error: node.name, ...(node.classes.length > 0 && { classes: node.classes.map(span => text(file, span)) }) }
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

  it('closes a fence past a `---` line inside a template literal or a comment, and on the first one when a template literal never closes', () => {
    const markdown = parse('--- server\nconst md = `---\ntitle: x\n---\nbody`\n/*\n---\n*/\n---\np {md}\n')
    const unclosed = parse('---\nconst s = "`"\nconst bad = `oops\n---\np x\n')

    expect(text(markdown, markdown.server)).toBe('const md = `---\ntitle: x\n---\nbody`\n/*\n---\n*/\n')
    expect(outline(markdown)).toEqual([{ tag: 'p', children: [['{md}']] }])
    expect(text(unclosed, unclosed.script)).toBe('const s = "`"\nconst bad = `oops\n')
    expect(outline(unclosed)).toEqual([{ tag: 'p', children: [['x']] }])
  })

  it('closes a fence on the labeled line opening the next one, `--- script` naming the component script', () => {
    const merged = parse('--- server\nconst a = 1\n--- script\nconst b = 2\n---\np {a}\n')
    const literal = parse('---\nconst b = 2\n--- server\nconst md = `\n--- client\n`\n---\np {b}\n')

    expect([text(merged, merged.server), text(merged, merged.script)]).toEqual(['const a = 1\n', 'const b = 2\n'])
    expect(outline(merged)).toEqual([{ tag: 'p', children: [['{a}']] }])
    expect(merged.diagnostics).toEqual([])
    expect(text(literal, literal.server)).toBe('const md = `\n--- client\n`\n')
    expect(parse('--- server\nconst a = 1\n--- sever\nx\n---\np\n').diagnostics[0]?.message).toContain('Unknown fence `--- sever`')
  })

  it('reports an unclosed fence', () => {
    expect(parse('---\nconst a = 1\n').diagnostics[0]?.message).toContain('never closed')
  })

  it('names a fence kind spelled with capitals or without a space as unknown', () => {
    expect(parse('--- Server\nconst a = 1\n---\np hi').diagnostics[0]?.message).toContain('Unknown fence `--- Server`')
    expect(parse('---server\nconst a = 1\n---\np hi').diagnostics[0]?.message).toContain('Unknown fence `---server`')
  })

  it('reads `--- client` as the script fence of a component rendering in the browser only, generic ones included', () => {
    const client = parse('--- client\nconst a = 1\n---\np hi\n')
    const generic = parse('--- client <T extends string>\nconst { a } = props<{ a: T }>()\n---\np {a}\n')

    expect(text(client, client.script)).toBe('const a = 1\n')
    expect(text(client, client.client)).toBe('client')
    expect(text(generic, generic.typeParameters)).toBe('T extends string')
    expect(text(generic, generic.client)).toBe('client')
    expect([...client.diagnostics, ...generic.diagnostics]).toEqual([])
    expect(parse('---\nconst a = 1\n---\np hi\n').client).toBeUndefined()
  })

  it('reports type parameters on the server fence', () => {
    expect(parse('--- server <T>\nconst a = 1\n---\np hi\n').diagnostics.map(diagnostic => [diagnostic.message, diagnostic.help])).toEqual([['Type parameters go on the component script fence', '`--- <T>`']])
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

  it('reports a control line after `tag: ` rather than reading it as an element', () => {
    const at = (source: string) => parse(source).diagnostics.map(d => [source.slice(d.start, d.end), d.message.slice(0, 30)])

    expect(at('li: if a\n  p x')).toEqual([['if', '`if` starts a line of its own']])
    expect(parse('li: if a\n  p x').diagnostics[0]?.help).toBe('put it on the next line, indented under <li>')
    expect(at('ul: for x of xs key={x}\n  li x')).toEqual([['for', '`for` starts a line of its own']])
    expect(at('div: await p then v')).toEqual([['await', '`await` starts a line of its o']])
  })

  it('reports the pug lines kay has no counterpart for, with their indented block', () => {
    const at = (source: string) => parse(source).diagnostics.map(d => [source.slice(d.start, d.end), d.message.slice(0, 40)])

    expect(at('each x in xs\n  p {x}')).toEqual([['each', '`each` is pug syntax kay does not have']])
    expect(parse('each x in xs\n  p {x}').diagnostics[0]?.help).toBe('kay loops with `for item of list`')
    expect(at('doctype html\np')).toEqual([['doctype', '`doctype` is pug syntax kay does not hav']])
    expect(at('div\n  include a.pug')).toEqual([['include', '`include` is pug syntax kay does not hav']])
    expect(at('blockquote each one\np while\n')).toEqual([])
  })
})

describe('error', () => {
  it('names the field whose message it shows, quoted or not, none for the form\'s own, with classes of its own', () => {
    const file = parse('form\n  error\n  error title\n  error.text-sm.mt-1 "first name"\n  error \'x-y\'')

    expect(file.diagnostics).toEqual([])
    expect(outline(file)).toEqual([{ tag: 'form', children: [{ error: '' }, { error: 'title' }, { error: 'first name', classes: ['text-sm', 'mt-1'] }, { error: 'x-y' }] }])
  })

  it('rejects a second word and children, leaving an element named error-like alone', () => {
    const at = (source: string) => parse(source).diagnostics.map(d => [source.slice(d.start, d.end), d.message])

    expect(at('error title body')).toEqual([['body', 'An `error` line names one field']])
    expect(at('error title\n  p x')).toEqual([['p x', 'An `error` line has no children: it shows the message the action gives']])
    expect(outline(parse('errors x'))).toEqual([{ tag: 'errors', children: [['x']] }])
  })
})

describe('const', () => {
  it('declares a name or a destructuring pattern among its siblings, its value running to the end of the line or of its brackets', () => {
    const file = parse('for p of ps\n  const price = p.cents / 100\n  const { name, tags: [first] = [] } = p\n  const total = sum({\n    a: 1,\n  })\n  li {price}')

    expect(file.diagnostics).toEqual([])
    expect(outline(file)).toEqual([{ for: 'p', index: undefined, of: 'ps', key: undefined, fallback: undefined, children: [
      { const: 'price', value: 'p.cents / 100' },
      { const: '{ name, tags: [first] = [] }', value: 'p' },
      { const: 'total', value: 'sum({\n    a: 1,\n  })' },
      { tag: 'li', children: [['{price}']] },
    ] }])
  })

  it('rejects let, a malformed const, children under one, and pug\'s code lines, pointing at const', () => {
    const at = (source: string) => parse(source).diagnostics.map(d => [source.slice(d.start, d.end), d.message])

    expect(at('let n = 1')).toEqual([['let', 'A template declares names with `const`, not `let`']])
    expect(at('const = 1')).toEqual([['const = 1', 'Malformed `const`']])
    expect(at('const n =')).toEqual([['const n =', 'A `const` needs a value']])
    expect(at('const n = 1\n  p x')).toEqual([['p x', 'A `const` line has no children: the lines after it at its indentation read its name']])
    expect(at('- const n = 1')).toEqual([['-', '`- code` is pug syntax kay does not have']])
    expect(parse('- const n = 1').diagnostics[0]?.help).toBe('a template names a value with `const name = value`; other code goes in the script')
  })

  it('leaves a var element alone', () => {
    const file = parse('var x\nvar {x}')

    expect(file.diagnostics).toEqual([])
    expect(outline(file)).toEqual([{ tag: 'var', children: [['x']] }, { tag: 'var', children: [['{x}']] }])
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

  it('reads a for without a key, its rows matched by item.id or the item', () => {
    const file = parse('for t of list\n  li x')

    expect(file.diagnostics).toEqual([])
    expect((file.template[0] as ForNode).key).toBeUndefined()
  })

  it('reads a match, its when lines split at their top-level commas and a last else', () => {
    const file = parse('match post.status\n  // the cases\n  when \'draft\'\n    p Draft\n  when \'a, b\', pick(1, 2), [3]\n    p Live\n  else\n    p Unknown')
    const node = file.template[0] as IfNode

    expect(file.diagnostics).toEqual([])
    expect(text(file, node.subject)).toBe('post.status')
    expect(node.branches.map(branch => branch.values?.map(value => text(file, value)))).toEqual([['\'draft\''], ['\'a, b\'', 'pick(1, 2)', '[3]'], undefined])
    expect(node.branches.map(branch => branch.children.length)).toEqual([1, 1, 1])
  })

  it('rejects a match without a subject or a when, other lines in it, an else before a when, and a when outside one', () => {
    const at = (source: string) => parse(source).diagnostics.map(d => [source.slice(d.start, d.end), d.message])

    expect(at('match\n  when 1\n    p')).toEqual([['match', 'Expected the value to match']])
    expect(at('match x\n  p a')).toEqual([['p a', 'A `match` holds `when` lines and a last `else`'], ['match x', '`match` has no `when` line']])
    expect(at('match x\n  when 1\n  else\n  when 2')).toEqual([['when 2', '`else` comes last in a `match`']])
    expect(at('match x\n  when 1,\n    p')).toEqual([['\n', 'Expected a value']])
    expect(at('when 1\n  p a')).toEqual([['when', '`when` sits in a `match` block']])
    expect(at('match x\n  when 1\nelse\n  p b')[0]?.[1]).toContain('must directly follow')
    expect(parse('case x\n  when 1').diagnostics[0]?.help).toBe('kay picks among values with `match value` and its `when` lines')
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
    expect(parse('for todo of todos\n  key={todo.id}\n  p').diagnostics[0]?.help).toContain('a `for`\'s key goes on the `for` line')
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
    expect(parse('await x\n  p wait\np after').diagnostics[0]?.message).toBe('`await` has no `then` block')
    expect(parse('p a\nthen x').diagnostics[0]?.message).toContain('`then` must directly follow an `await`')
    expect(parse('await x\n  p\ncatch e\n  p').diagnostics.map(d => d.message)).toContain('`catch` must directly follow a `try`, or the `then` of an `await`, at the same indentation')
    expect(parse('await x then a\n  p\nthen b\n  p').diagnostics[0]?.message).toContain('`then` must directly follow')
  })

  it('reads try with its catch block, the error named or not', () => {
    const file = parse('try\n  Chart\ncatch error\n  p {error}\ntry\n  p a\np after')

    expect(outline(file)).toEqual([
      { try: [{ tag: 'Chart' }], rejected: { alias: 'error', children: [{ tag: 'p', children: [['{error}']] }] } },
      { try: [{ tag: 'p', children: [['a']] }], rejected: undefined },
      { tag: 'p', children: [['after']] },
    ])
    expect(file.diagnostics).toEqual([])
  })

  it('rejects text on a try line, and a second catch', () => {
    expect(parse('try now\n  p').diagnostics.map(d => d.message)).toEqual(['`try` takes nothing on its line'])
    expect(parse('try\n  p\ncatch\n  p\ncatch\n  p').diagnostics.map(d => d.message)).toEqual(['`catch` must directly follow a `try`, or the `then` of an `await`, at the same indentation'])
  })

  it('reads slots under a component', () => {
    const file = parse('Loading\n  @fallback\n    p wait\n  p ready')

    expect(outline(file)).toEqual([{ tag: 'Loading', children: [{ slot: 'fallback', children: [{ tag: 'p', children: [['wait']] }] }, { tag: 'p', children: [['ready']] }] }])
  })

  it('reads the parameters of a slot, which may span lines', () => {
    expect(outline(parse('List\n  @row({ id, title }, i)\n    li {title}'))).toEqual([{ tag: 'List', children: [{ slot: 'row', params: '{ id, title }, i', children: [{ tag: 'li', children: [['{title}']] }] }] }])
    expect(outline(parse('List\n  @row(\n    todo,\n  )\n    li x'))).toEqual([{ tag: 'List', children: [{ slot: 'row', params: '\n    todo,\n  ', children: [{ tag: 'li', children: [['x']] }] }] }])
    expect(parse('List\n  @row(todo) li x').diagnostics.map(d => d.message)).toEqual(['Nothing may follow the parameters of a slot on its line'])
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
