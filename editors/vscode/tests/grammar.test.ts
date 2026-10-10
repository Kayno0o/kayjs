import type { IGrammar, IRawGrammar } from 'vscode-textmate'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { loadWASM, OnigScanner, OnigString } from 'vscode-oniguruma'
import { INITIAL, Registry } from 'vscode-textmate'

// Stands in for VS Code's TypeScript grammar with the constructs that interact with the kay grammar's own braces.
const typescript = {
  scopeName: 'source.ts',
  patterns: [
    { match: String.raw`\b[A-Za-z_$][\w$]*\b`, name: 'variable.other.ts' },
    { begin: '`', end: '`', name: 'string.template.ts', patterns: [{ begin: String.raw`\$\{`, end: String.raw`\}`, patterns: [{ include: 'source.ts' }] }] },
    { begin: String.raw`\{`, end: String.raw`\}`, name: 'meta.block.ts', patterns: [{ include: 'source.ts' }] },
    { begin: '\'', end: '\'', name: 'string.quoted.single.ts' },
  ],
}

let grammar: IGrammar

beforeAll(async () => {
  await loadWASM(await Bun.file(join(import.meta.dir, '..', 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm')).arrayBuffer())

  const kay = await Bun.file(join(import.meta.dir, '..', 'syntaxes', 'kay.tmLanguage.json')).json() as IRawGrammar
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner: patterns => new OnigScanner(patterns), createOnigString: text => new OnigString(text) }),
    loadGrammar: async scopeName => scopeName === 'source.kay' ? kay : scopeName === 'source.ts' ? typescript as unknown as IRawGrammar : null,
  })

  grammar = (await registry.loadGrammar('source.kay'))!
})

// Each line's tokens as `text: innermost scope`, neighbours sharing a scope merged and whitespace left out.
function tokenize(source: string): string[][] {
  let state = INITIAL

  return source.split('\n').map((line) => {
    const result = grammar.tokenizeLine(line, state)
    const merged: { text: string, scope: string }[] = []

    state = result.ruleStack
    for (const token of result.tokens) {
      const text = line.slice(token.startIndex, token.endIndex)
      const scope = token.scopes.at(-1)!
      const last = merged.at(-1)

      if (last?.scope === scope)
        last.text += text
      else
        merged.push({ text, scope })
    }

    return merged.filter(token => token.text.trim() !== '').map(token => `${token.text.trim()}: ${token.scope}`)
  })
}

function scopesOf(source: string, text: string): string[] {
  let state = INITIAL

  for (const line of source.split('\n')) {
    const result = grammar.tokenizeLine(line, state)
    const token = result.tokens.find(candidate => line.slice(candidate.startIndex, candidate.endIndex) === text)

    if (token)
      return token.scopes

    state = result.ruleStack
  }

  return []
}

describe('kay grammar', () => {
  it('embeds TypeScript in both fences and returns to the template after them', () => {
    const lines = tokenize('--- server\nconst open = 1\n---\n---\nconst title = \'x\'\n---\np Hi')

    expect(lines[0]).toEqual(['---: punctuation.definition.fence.kay', 'server: keyword.other.fence.kay'])
    expect(lines[1]).toContain('open: variable.other.ts')
    expect(scopesOf('---\nconst title = \'x\'\n---', 'title')).toContain('meta.embedded.block.typescript')
    expect(lines[6]).toEqual(['p: entity.name.tag.kay', 'Hi: meta.element.kay'])
  })

  it('ends a fence at the labeled line opening the next one', () => {
    const lines = tokenize('--- server\nconst open = 1\n--- script\nconst title = \'x\'\n---\np Hi')

    expect(lines[2]).toEqual(['---: punctuation.definition.fence.kay', 'script: keyword.other.fence.kay'])
    expect(scopesOf('--- server\nconst open = 1\n--- script\nconst title = \'x\'\n---', 'title')).toContain('meta.embedded.block.typescript')
    expect(lines[5]).toEqual(['p: entity.name.tag.kay', 'Hi: meta.element.kay'])
  })

  it('reads the type parameters of a generic component on its fence line', () => {
    const lines = tokenize('--- <T extends Row>\nconst x = 1\n---\np Hi')

    expect(lines[0]).toEqual(['---: punctuation.definition.fence.kay', '<T extends Row>: meta.type.parameters.kay'])
    expect(lines[3]).toEqual(['p: entity.name.tag.kay', 'Hi: meta.element.kay'])
  })

  it('tells components, tags, classes, ids and attributes apart', () => {
    const [line] = tokenize('Card.p-4.md:flex#main(title="Todos" open onClick={go} {...rest}) Hello {name}')

    expect(line).toEqual([
      'Card: support.class.component.kay',
      '.p-4.md:flex: entity.other.attribute-name.class.kay',
      '#main: entity.other.attribute-name.id.kay',
      '(: punctuation.definition.attributes.begin.kay',
      'title: entity.other.attribute-name.kay',
      '=: punctuation.separator.key-value.kay',
      '"Todos": string.quoted.double.kay',
      'open: entity.other.attribute-name.kay',
      'onClick: entity.other.attribute-name.kay',
      '=: punctuation.separator.key-value.kay',
      '{: punctuation.section.embedded.begin.kay',
      'go: variable.other.ts',
      '}: punctuation.section.embedded.end.kay',
      '{: punctuation.section.embedded.begin.kay',
      '...: source.ts',
      'rest: variable.other.ts',
      '}: punctuation.section.embedded.end.kay',
      '): punctuation.definition.attributes.end.kay',
      'Hello: meta.element.kay',
      '{: punctuation.section.embedded.begin.kay',
      'name: variable.other.ts',
      '}: punctuation.section.embedded.end.kay',
    ])
  })

  it('reads control flow, slots, comments and piped text', () => {
    const lines = tokenize([
      'for todo, i of todos key={todo.id}',
      '  li {i}',
      'if saved() as id',
      '  p {id}',
      'else if busy',
      'else',
      '@fallback',
      '// note',
      '| plain {x}',
      'slot row(item)',
      '{x}',
    ].join('\n'))

    expect(lines[0]).toEqual([
      'for: keyword.control.loop.kay',
      'todo: variable.other.readwrite.kay',
      ',: punctuation.separator.comma.kay',
      'i: variable.other.readwrite.kay',
      'of: keyword.control.loop.kay',
      'todos: variable.other.ts',
      'key: entity.other.attribute-name.kay',
      '=: punctuation.separator.key-value.kay',
      '{: punctuation.section.embedded.begin.kay',
      'todo: variable.other.ts',
      '.: source.ts',
      'id: variable.other.ts',
      '}: punctuation.section.embedded.end.kay',
    ])
    expect(lines[2]).toEqual(['if: keyword.control.conditional.kay', 'saved: variable.other.ts', '(): meta.embedded.expression.kay', 'as: keyword.control.as.kay', 'id: variable.other.readwrite.alias.kay'])
    expect(lines[4]).toEqual(['else if: keyword.control.conditional.kay', 'busy: variable.other.ts'])
    expect(lines[5]).toEqual(['else: keyword.control.conditional.kay'])
    expect(lines[6]).toEqual(['@: punctuation.definition.slot.kay', 'fallback: entity.other.attribute-name.slot.kay'])
    expect(lines[7]).toEqual(['// note: comment.line.double-slash.kay'])
    expect(lines[8]).toEqual(['|: punctuation.definition.text.kay', 'plain: source.kay', '{: punctuation.section.embedded.begin.kay', 'x: variable.other.ts', '}: punctuation.section.embedded.end.kay'])
    expect(lines[9]).toEqual(['slot: entity.name.tag.kay', 'row: entity.other.attribute-name.slot.kay', '(: punctuation.definition.parameters.begin.kay', 'item: variable.other.ts', '): punctuation.definition.parameters.end.kay'])
    expect(lines[10]).toEqual(['{: punctuation.section.embedded.begin.kay', 'x: variable.other.ts', '}: punctuation.section.embedded.end.kay'])
  })

  it('reads a const line, its pattern and value as TypeScript, and leaves a var element alone', () => {
    const lines = tokenize(['for p of ps', '  const price = p.cents', '  const { a } = p', 'var x'].join('\n'))

    expect(lines[1]).toEqual(['const: storage.type.kay', 'price: variable.other.ts', '=: keyword.operator.assignment.kay', 'p: variable.other.ts', '.: meta.embedded.expression.kay', 'cents: variable.other.ts'])
    expect(lines[2]).toEqual(['const: storage.type.kay', '{: meta.block.ts', 'a: variable.other.ts', '}: meta.block.ts', '=: keyword.operator.assignment.kay', 'p: variable.other.ts'])
    expect(lines[3]![0]).toBe('var: entity.name.tag.kay')
  })

  it('reads a try block with its catch branch', () => {
    const lines = tokenize(['try', '  p Fine', 'catch error'].join('\n'))

    expect(lines[0]).toEqual(['try: keyword.control.flow.kay'])
    expect(lines[2]).toEqual(['catch: keyword.control.flow.kay', 'error: variable.other.readwrite.alias.kay'])
  })

  it('reads await blocks with their then and catch branches', () => {
    const lines = tokenize(['await comments', '  p Loading', 'then list', 'catch error', 'await user then found', 'then'].join('\n'))

    expect(lines[0]).toEqual(['await: keyword.control.flow.kay', 'comments: variable.other.ts'])
    expect(lines[2]).toEqual(['then: keyword.control.flow.kay', 'list: variable.other.readwrite.alias.kay'])
    expect(lines[3]).toEqual(['catch: keyword.control.flow.kay', 'error: variable.other.readwrite.alias.kay'])
    expect(lines[4]).toEqual(['await: keyword.control.flow.kay', 'user: variable.other.ts', 'then: keyword.control.flow.kay', 'found: variable.other.readwrite.alias.kay'])
    expect(lines[5]).toEqual(['then: keyword.control.flow.kay'])
  })

  it('handles block expansion, inline elements, escapes and nested braces', () => {
    const [expansion, inline] = tokenize('li: a(href={`/t/${id}`}) {todo.title}\np Hi \\{ #[b.x(y=\'1\') bold] {({ a: 1 }).a}')

    expect(expansion).toContain('a: entity.name.tag.kay')
    expect(expansion).toContain(':: punctuation.separator.block-expansion.kay')
    expect(expansion).toContain('title: variable.other.ts')
    expect(expansion?.at(-1)).toBe('}: punctuation.section.embedded.end.kay')
    expect(inline).toContain('\\{: constant.character.escape.kay')
    expect(inline).toContain('b: entity.name.tag.kay')
    expect(inline).toContain('.x: entity.other.attribute-name.class.kay')
    expect(inline).toContain('\'1\': string.quoted.single.kay')
    expect(inline).toContain(']: punctuation.definition.inline-element.end.kay')
    expect(inline?.at(-1)).toBe('}: punctuation.section.embedded.end.kay')
  })

  it('does not read a colon in text as block expansion', () => {
    const [line] = tokenize('p Note: this is text')

    expect(line).toEqual(['p: entity.name.tag.kay', 'Note: this is text: meta.element.kay'])
  })

  it('keeps tokenizing a multi-line attribute list', () => {
    const lines = tokenize('form(\n  action={add}\n  method="post"\n)\n  input')

    expect(lines[1]).toContain('action: entity.other.attribute-name.kay')
    expect(lines[2]).toContain('"post": string.quoted.double.kay')
    expect(lines[3]).toEqual(['): punctuation.definition.attributes.end.kay'])
    expect(lines[4]).toEqual(['input: entity.name.tag.kay'])
  })
})
