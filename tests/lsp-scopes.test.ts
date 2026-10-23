import type { Route } from '../src/server/routes'
import { describe, expect, it } from 'bun:test'
import { formatKay } from '../src/compiler/format'
import { SourceMap } from '../src/compiler/mapping'
import { formatRange } from '../src/lsp/range-format'
import { mentionsRoute, routeAt } from '../src/lsp/route-links'
import { semanticTokens, splitEntries, TOKEN_MODIFIERS, TOKEN_TYPES } from '../src/lsp/semantic-tokens'

// Each token as the text it covers, its type and its modifiers.
function tokens(text: string, imported = {}): string[] {
  const data = semanticTokens(text, imported)
  const lines = text.split('\n')
  const found: string[] = []
  let line = 0
  let character = 0

  for (let at = 0; at < data.length; at += 5) {
    line += data[at]!
    character = data[at] === 0 ? character + data[at + 1]! : data[at + 1]!

    const mods = TOKEN_MODIFIERS.filter((_, bit) => (data[at + 4]! & (1 << bit)) !== 0)

    found.push(`${line}:${character} ${lines[line]!.slice(character, character + data[at + 2]!)} ${TOKEN_TYPES[data[at + 3]!]} ${mods.join(',')}`)
  }

  return found
}

const page = (...lines: string[]) => [...lines, ''].join('\n')

describe('semantic tokens in template expressions', () => {
  const head = ['---', 'const count = signal(0)', '---']

  it('hides a name only where a function declares it', () => {
    // The inner function declares `count`, the outer one's read of it is still the file's signal.
    expect(tokens(page(...head, 'p {[1].map(() => { function inner() { const count = 1 } return count })}'))).toEqual(['1:6 count variable declaration,signal', '3:63 count variable signal'])
    expect(tokens(page(...head, 'p {[1].map(() => { const count = 1; return count })}'))).toEqual(['1:6 count variable declaration,signal'])
  })

  it('treats a catch parameter as a binder', () => {
    expect(tokens(page(...head, 'p {(() => { try { run() } catch (count) { return count } })()}'))).toEqual(['1:6 count variable declaration,signal'])
  })

  it('treats a destructured catch parameter as a binder', () => {
    expect(tokens(page(...head, 'p {(() => { try { run() } catch ({ count }) { return count } })()}'))).toEqual(['1:6 count variable declaration,signal'])
    expect(tokens(page(...head, 'p {(() => { try { run() } catch ([count]) { return count } })()}'))).toEqual(['1:6 count variable declaration,signal'])
  })

  it('still tokens a write to the file\'s name', () => {
    expect(tokens(page(...head, 'button(onClick={() => count = 5}) x', 'button(onClick={() => count++}) y', 'button(onClick={() => [count] = [1]}) z'))).toEqual(['1:6 count variable declaration,signal', '3:22 count variable signal', '4:22 count variable signal', '5:23 count variable signal'])
  })

  it('treats a nested function declaration and its parameters as binders', () => {
    expect(tokens(page(...head, 'p {[1].map(function count(count) { return count })}'))).toEqual(['1:6 count variable declaration,signal'])
  })
})

describe('semantic tokens and shadowing of the server fence', () => {
  it('reads a script const shadowing a server value as the script\'s own', () => {
    const text = page('--- server', 'const greeting = \'a\'', 'const other = 1', '---', '---', 'const greeting = \'b\'', '---', 'p {greeting} {other}')

    expect(tokens(text)).toEqual(['1:6 greeting variable declaration,readonly,server', '2:6 other variable declaration,readonly,server', '7:14 other variable readonly,server'])
  })
})

describe('semantic tokens by import', () => {
  it('recognises a signal made through an alias of the kay import', () => {
    const text = page('---', 'import { signal as sig, memo as m } from \'kay\'', 'const count = sig(0)', 'const twice = m(() => count * 2)', '---', 'p {count} {twice}')

    expect(tokens(text)).toEqual(['2:6 count variable declaration,signal', '3:6 twice variable declaration,readonly,signal', '3:22 count variable signal', '5:3 count variable signal', '5:11 twice variable readonly,signal'])
  })

  it('leaves a function of the same name imported from elsewhere as no signal', () => {
    expect(tokens(page('---', 'import { signal } from \'./mine\'', 'const count = signal(0)', '---', 'p {count}'))).toEqual([])
  })
})

describe('semantic tokens of a fence Babel cannot parse', () => {
  it('keeps the props, imports and signals of the fence for the template', () => {
    const text = page('---', 'import { open } from \'../store\'', 'const { title, subtitle = \'x\' } = props<{ title: string, subtitle?: string }>()', 'const count = signal(0)', 'const view = <b>{count}</b>', '---', 'p {title} {subtitle} {count} {open}')

    expect(tokens(text, { '../store': { open: 'signal' } })).toEqual([
      '1:9 open variable declaration,signal',
      '2:8 title property declaration,prop',
      '2:15 subtitle property declaration,prop',
      '3:6 count variable declaration,signal',
      '6:3 title property prop',
      '6:11 subtitle property prop',
      '6:22 count variable signal',
      '6:30 open variable signal',
    ])
  })
})

describe('semantic tokens of a broken import and of props read as text', () => {
  it('gives a signal imported in a statement Babel cannot parse its token', () => {
    const text = page('---', 'import { open } from \'../store\' garbage', 'const x = 1', '---', 'p {open}')

    expect(tokens(text, { '../store': { open: 'signal' } })).toEqual(['1:9 open variable declaration,signal', '4:3 open variable signal'])
  })

  it('keeps a default holding a comma and a nested pattern in the props list', () => {
    const text = page('---', 'const { a = f(x, y), b: { c }, d, e: renamed, ...rest } = props<{ a?: number }>()', 'const view = <b>{a}</b>', '---', 'p {a} {d} {renamed} {y} {c}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '1:31 d property declaration,prop', '1:37 renamed property declaration,prop', '4:3 a property prop', '4:7 d property prop', '4:11 renamed property prop'])
  })

  it('keeps the props list past an escaped quote in a string default', () => {
    const text = page('---', 'const { a = \'it\\\'s, ok\', d } = props<{ a?: string }>()', 'const view = <b>{a}</b>', '---', 'p {a} {d}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '1:25 d property declaration,prop', '4:3 a property prop', '4:7 d property prop'])
  })

  it('keeps the props list past a comma or a brace in a line comment', () => {
    const text = page('---', 'const { a = 1, // a, } \' comment\n d } = props<{ a?: number }>()', 'const view = <b>{a}</b>', '---', 'p {a} {d}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '2:1 d property declaration,prop', '5:3 a property prop', '5:7 d property prop'])
  })

  it('keeps the props list past a comma or a brace in a block comment', () => {
    const text = page('---', 'const { a = 1, /* b, } \' */ d } = props<{ a?: number }>()', 'const view = <b>{a}</b>', '---', 'p {a} {d}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '1:28 d property declaration,prop', '4:3 a property prop', '4:7 d property prop'])
  })

  it('keeps the props list past a template literal and its substitution', () => {
    const text = page('---', 'const { a = `x, ${`}, `} }`, d } = props<{ a?: string }>()', 'const view = <b>{a}</b>', '---', 'p {a} {d}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '1:29 d property declaration,prop', '4:3 a property prop', '4:7 d property prop'])
  })

  it('keeps the props list past a quote, a comma or a brace in a regex literal', () => {
    const text = page('---', 'const { a = /["\',}]/, d } = props<{ a?: RegExp }>()', 'const view = <b>{a}</b>', '---', 'p {a} {d}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '1:22 d property declaration,prop', '4:3 a property prop', '4:7 d property prop'])
  })

  it('keeps a division in a default apart from a regex literal', () => {
    const text = page('---', 'const { a = 4 / 2, b = x / 2, d } = props<{ a?: number }>()', 'const view = <b>{a}</b>', '---', 'p {a} {b} {d}')

    expect(tokens(text)).toEqual(['1:8 a property declaration,prop', '1:19 b property declaration,prop', '1:30 d property declaration,prop', '4:3 a property prop', '4:7 b property prop', '4:11 d property prop'])
  })

  it('stops a literal at the end of the entries it splits', () => {
    expect(splitEntries('a, "b, c', 0, 5)).toEqual([[0, 1], [2, 5]])
    expect(splitEntries('a, /* b, c', 0, 5)).toEqual([[0, 1], [2, 5]])
  })

  it('knows the signals the script fence imports in a module fence it cannot parse', () => {
    const text = page('--- module', 'const shared = signal(0)', 'const view = <b>{shared}</b>', '---', '---', 'import { signal } from \'kay\'', '---', 'p {shared}')

    expect(tokens(text)).toEqual(['1:6 shared variable declaration,signal', '7:3 shared variable signal'])
  })

  it('treats a destructured catch parameter of a fence as a binder', () => {
    const text = page('---', 'const count = signal(0)', 'try { run() } catch ({ count }) { log(count) }', 'try { run() } catch ([count]) { log(count) }', '---')

    expect(tokens(text)).toEqual(['1:6 count variable declaration,signal'])
  })
})

describe('route links', () => {
  const route = (pattern: string, file: string, matchers?: Record<string, string>): Route => ({ pattern, file, params: [], layouts: [], special: {}, guards: [], ...matchers && { matchers } })

  it('prefers a param route over a catch-all on a tie, whatever the order', () => {
    const routes = [route('/docs/*', 'catch.kay'), route('/docs/:id', 'param.kay')]

    expect(routeAt('/docs/a', routes, [])?.file).toBe('param.kay')
    expect(routeAt('/docs/a', routes.toReversed(), [])?.file).toBe('param.kay')
    expect(routeAt('/docs/a/b', routes, [])?.file).toBe('catch.kay')
  })

  it('checks a param against the built-in matcher of its segment, and tries a matched route first', () => {
    const routes = [route('/posts/:id', 'plain.kay'), route('/posts/:id', 'number.kay', { id: 'integer' })]

    expect(routeAt('/posts/42', routes, [])?.file).toBe('number.kay')
    expect(routeAt('/posts/abc', routes, [])?.file).toBe('plain.kay')
    expect(routeAt('/posts/abc', [routes[1]!], [])).toBeUndefined()
  })

  it('accepts a param that a matcher of the project may take, as it cannot be run', () => {
    expect(routeAt('/posts/abc', [route('/posts/:id', 'mine.kay', { id: 'mine' })], [])?.file).toBe('mine.kay')
  })

  it('lets a project matcher shadow the one kay ships of its name', () => {
    const routes = [route('/posts/:id', 'number.kay', { id: 'integer' })]

    expect(routeAt('/posts/abc', routes, [])).toBeUndefined()
    expect(routeAt('/posts/abc', routes, [], new Set(['integer']))?.file).toBe('number.kay')
  })

  it('runs the matcher of a catch-all on the rest of the path', () => {
    const routes = [{ ...route('/docs/*', 'slug.kay', { rest: 'integer' }), catchAll: 'rest' }]

    expect(routeAt('/docs/12', routes, [])?.file).toBe('slug.kay')
    expect(routeAt('/docs/a/b', routes, [])).toBeUndefined()
  })

  it('reads a path under a locale prefix as the route it prefixes', () => {
    const routes = [route('/about', 'about.kay'), route('/fr/:slug', 'fr.kay')]

    expect(routeAt('/fr/about', routes, ['fr', 'en'])?.file).toBe('fr.kay')
    expect(routeAt('/en/about', routes, ['fr', 'en'])?.file).toBe('about.kay')
    expect(routeAt('/de/about', routes, ['fr', 'en'])).toBeUndefined()
  })

  it('reads the route table only for a text naming a route', () => {
    expect(mentionsRoute('a(href="/about") x')).toBe(true)
    expect(mentionsRoute('form(action="/x")')).toBe(true)
    expect(mentionsRoute('button(onClick={() => navigate("/a")}) x')).toBe(true)
    expect(mentionsRoute('p /about is a path')).toBe(false)
  })
})

describe('range formatting before the first template block', () => {
  const apply = (text: string, edits: ReturnType<typeof formatRange>) => edits.toReversed().reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text)

  it('drops the blank lines before the first block as the whole file does', () => {
    for (const text of ['---\nconst a = 1\n---\n\n\n\np Hi\n', '\n\np Hi\n', '---\nconst a = 1\n---\n\np Hi\n\np B\n'])
      expect(apply(text, formatRange(text, { start: 0, end: text.length }))).toBe(formatKay(text).code)
  })

  it('leaves them when the range touches no block', () => {
    const text = '---\nconst a = 1\n---\n\n\np Hi\n'

    expect(formatRange(text, { start: 4, end: 10 })).toEqual([])
  })
})

describe('range formatting at the edges of the first block', () => {
  it('touches nothing over the blank lines before the first block', () => {
    const text = '---\nconst a = 1\n---\n\n\n\np   Hi\n'

    expect(formatRange(text, { start: 18, end: 20 })).toEqual([])
  })

  it('folds the blank lines of a CRLF file as a whole file does', () => {
    const text = '---\r\nconst a = 1\r\n---\r\n\r\n\r\np Hi\r\n'
    const [edit] = formatRange(text, { start: 0, end: text.length })

    expect(edit).toBeDefined()
    expect(text.slice(0, edit!.start) + edit!.text + text.slice(edit!.end)).toBe(formatKay(text).code.replaceAll('\n', '\r\n'))
  })
})

describe('the generated code of a source range', () => {
  const map = new SourceMap([{ generated: 100, source: 10, length: 5 }, { generated: 20, source: 30, length: 4 }, { generated: 60, source: 50, length: 6 }], [])

  it('runs from the first generated copy to the last of what the range covers, whatever the order of the generated code', () => {
    expect(map.generatedHull(12, 32)).toEqual({ start: 20, end: 105 })
    expect(map.generatedHull(0, 60)).toEqual({ start: 20, end: 105 })
    expect(map.generatedHull(31, 52)).toEqual({ start: 21, end: 62 })
  })

  it('counts a copy touching an edge of the range, as a type hint sits right after a name', () => {
    expect(map.generatedHull(15, 29)).toEqual({ start: 105, end: 105 })
  })

  it('is nothing for a range copying no code', () => {
    expect(map.generatedHull(16, 29)).toBeUndefined()
    expect(map.generatedHull(70, 90)).toBeUndefined()
  })
})
