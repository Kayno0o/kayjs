import { describe, expect, it } from 'bun:test'
import { parsePartial } from '../src/partial-json'

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
