import { describe, expect, it } from 'bun:test'
import { withoutEmptyFiles } from '../src/server/action-input'

describe('withoutEmptyFiles', () => {
  it('keeps a posted __proto__ field an own property, never the prototype of what the handler reads', () => {
    const body = JSON.parse('{"__proto__":{"admin":true},"title":"x","file":[]}') as unknown
    const fields = withoutEmptyFiles(body) as Record<string, unknown>

    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype)
    expect(fields.admin).toBeUndefined()
    expect(Object.keys(fields).sort()).toEqual(['__proto__', 'file', 'title'])
  })

  it('drops the empty files a form posts and keeps the rest', () => {
    const empty = new Blob([])
    const real = new File(['a'], 'a.txt')

    expect(withoutEmptyFiles({ one: empty, two: [empty, real], three: [empty], four: [], five: 'x' })).toEqual({ two: [real], four: [], five: 'x' })
  })
})
