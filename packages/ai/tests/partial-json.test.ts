import { describe, expect, it } from 'bun:test'
import { parsePartial, partialParser } from '../src/partial-json'

describe('a JSON answer read before it is whole', () => {
  it('shows a string as far as it came, and nothing before the object opened', () => {
    expect(parsePartial('')).toBeUndefined()
    expect(parsePartial('  \n')).toBeUndefined()
    expect(parsePartial('{')).toEqual({})
    expect(parsePartial('{"title":"Hel')).toEqual({ title: 'Hel' })
    expect(parsePartial('{"title":"Hello","note":"wor')).toEqual({ title: 'Hello', note: 'wor' })
    expect(parsePartial('{"title":"')).toEqual({ title: '' })
  })

  it('leaves out a key still being written and a value not started', () => {
    expect(parsePartial('{"ti')).toEqual({})
    expect(parsePartial('{"title"')).toEqual({})
    expect(parsePartial('{"title":')).toEqual({})
    expect(parsePartial('{"a":"x",')).toEqual({ a: 'x' })
    expect(parsePartial('{"a":"x", "b"')).toEqual({ a: 'x' })
  })

  it('shows a number, a boolean and a null only once they are complete', () => {
    expect(parsePartial('{"n":12')).toEqual({})
    expect(parsePartial('{"n":12,')).toEqual({ n: 12 })
    expect(parsePartial('{"n":-1.5e3,"m":2}')).toEqual({ n: -1500, m: 2 })
    expect(parsePartial('{"n":1.')).toEqual({})
    expect(parsePartial('{"ok":tru')).toEqual({})
    expect(parsePartial('{"ok":true')).toEqual({ ok: true })
    expect(parsePartial('{"ok":false,"none":nul')).toEqual({ ok: false })
    expect(parsePartial('{"none":null')).toEqual({ none: null })
  })

  it('shows a nested object and an array as they stand, their strings growing', () => {
    expect(parsePartial('{"author":{"name":"Al')).toEqual({ author: { name: 'Al' } })
    expect(parsePartial('{"author":{"name":"Alice","age":4')).toEqual({ author: { name: 'Alice' } })
    expect(parsePartial('{"tags":["a","b')).toEqual({ tags: ['a', 'b'] })
    expect(parsePartial('{"tags":["a","b"],"n":1}')).toEqual({ tags: ['a', 'b'], n: 1 })
    expect(parsePartial('{"scores":[1,2,3')).toEqual({ scores: [1, 2] })
    expect(parsePartial('{"items":[{"n":"x","p":1},{"n":"y')).toEqual({ items: [{ n: 'x', p: 1 }, { n: 'y' }] })
    expect(parsePartial('{"items":[{"n":"x"},')).toEqual({ items: [{ n: 'x' }] })
    expect(parsePartial('{"items":[')).toEqual({ items: [] })
  })

  it('reads escapes, and drops an escape cut in the middle', () => {
    expect(parsePartial('{"a":"line\\nbreak \\"q\\" \\u00e9')).toEqual({ a: 'line\nbreak "q" é' })
    expect(parsePartial('{"a":"x\\')).toEqual({ a: 'x' })
    expect(parsePartial('{"a":"x\\u00')).toEqual({ a: 'x' })
    expect(parsePartial('{"a":"x\\ud83d')).toEqual({ a: 'x' })
  })

  it('reads the whole object once it is closed, and what follows is not its business', () => {
    expect(parsePartial('{"a":1}')).toEqual({ a: 1 })
    expect(parsePartial('{"a":1} and more')).toEqual({ a: 1 })
  })

  it('gives nothing for text that is no JSON object', () => {
    expect(parsePartial('Sure! {"a":1}')).toBeUndefined()
    expect(parsePartial('[1,2')).toBeUndefined()
    expect(parsePartial('{"a":x')).toBeUndefined()
    expect(parsePartial('{"a" 1}')).toBeUndefined()
    expect(parsePartial('{a:1}')).toBeUndefined()
  })

  it('keeps a hostile key as data, never as the object\'s prototype', () => {
    const read = parsePartial('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>

    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype)
    expect(read.a).toBe(1)
  })

  it('reads a long unfinished answer in one pass', () => {
    const text = `{"items":[${Array.from({ length: 2000 }, (_, index) => `{"n":${index},"label":"item ${index}"}`).join(',')}`
    const started = performance.now()

    expect((parsePartial(text) as { items: unknown[] }).items).toHaveLength(2000)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('partialParser', () => {
  const text = '{"title":"Hello \\"w\\u00e9\\" 😀","n":-1.5e3,"ok":true,"none":null,"tags":["a","b",[1,2]],"author":{"name":"Al","age":4},"__proto__":{"x":1}} trailing'

  it('reads the same object however the text is cut into pieces', () => {
    for (let size = 1; size <= text.length; size++) {
      const parser = partialParser()

      for (let at = 0; at < text.length; at += size) {
        parser.push(text.slice(at, at + size))
        expect(parser.value()).toEqual(parsePartial(text.slice(0, Math.min(at + size, text.length))))
      }
    }
  })

  it('says whether a piece changed what shows, so a piece that adds nothing is no new snapshot', () => {
    const parser = partialParser()

    expect(parser.push('  ')).toBe(false)
    expect(parser.push('{')).toBe(true)
    expect(parser.push('"title"')).toBe(false)
    expect(parser.push(':')).toBe(false)
    expect(parser.push('"He')).toBe(true)
    expect(parser.push('llo')).toBe(true)
    expect(parser.push('\\u00')).toBe(false)
    expect(parser.push('e9')).toBe(true)
    expect(parser.push('"')).toBe(false)
    expect(parser.push(',"n":12')).toBe(false)
    expect(parser.push(',')).toBe(true)
    expect(parser.push('"tags":[')).toBe(true)
    expect(parser.push(']')).toBe(false)
    expect(parser.push('}')).toBe(false)
    expect(parser.push('more')).toBe(false)
    expect(parser.value()).toEqual({ title: 'Helloé', n: 12, tags: [] })
  })

  it('shows no half of a surrogate pair', () => {
    const parser = partialParser()

    expect(parser.push('{"a":"x\\ud83d')).toBe(true)
    expect(parser.value()).toEqual({ a: 'x' })
    expect(parser.push('\\ude00')).toBe(true)
    expect(parser.value()).toEqual({ a: 'x😀' })
  })

  it('counts the closing quote as a change only when it shows more', () => {
    const parser = partialParser()

    expect(parser.push('{"a":"x')).toBe(true)
    expect(parser.push('y"')).toBe(true)
    expect(parser.push(',"b":"z\\ud83d')).toBe(true)
    expect(parser.push('"')).toBe(true)
    expect(parser.value()).toEqual({ a: 'xy', b: 'z\uD83D' })
  })

  it('refuses nesting past 64 levels, as it always did', () => {
    const nested = (depth: number) => '{"a":'.repeat(depth)

    expect(parsePartial(`${nested(64)}1}`)).toBeDefined()
    expect(parsePartial(`${nested(65)}[`)).toBeUndefined()
    expect(parsePartial(`${nested(65)}1`)).toBeUndefined()
  })

  it('hands out snapshots that later pieces do not change', () => {
    const parser = partialParser()

    parser.push('{"items":[{"n":1},{"n":"a')

    const before = parser.value()

    parser.push('b"},{"n":3}]}')
    expect(before).toEqual({ items: [{ n: 1 }, { n: 'a' }] })
    expect(parser.value()).toEqual({ items: [{ n: 1 }, { n: 'ab' }, { n: 3 }] })
  })

  it('stays undefined once the text is malformed, whatever follows', () => {
    const parser = partialParser()

    parser.push('{"a":x')
    expect(parser.push('"}')).toBe(false)
    expect(parser.value()).toBeUndefined()
  })

  it('reads a long answer piece by piece in time linear in its size', () => {
    const body = Array.from({ length: 4000 }, (_, index) => `{"n":${index},"label":"item ${index}"}`).join(',')
    const full = `{"items":[${body}]}`
    const parser = partialParser()
    const started = performance.now()
    let changes = 0

    for (let at = 0; at < full.length; at += 4) {
      if (parser.push(full.slice(at, at + 4))) {
        changes++
        parser.value()
      }
    }

    expect(changes).toBeGreaterThan(1000)
    expect((parser.value() as { items: unknown[] }).items).toHaveLength(4000)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
