import { describe, expect, test } from 'bun:test'
import { isInside } from '../src/plugins/public'
import { readStringFields } from '../src/server/public'

function post(body: BodyInit, contentType?: string): Request {
  return new Request('http://app.test/x', { method: 'POST', body, headers: contentType === undefined ? {} : { 'content-type': contentType } })
}

describe('isInside: the one path confinement check (#3672)', () => {
  test('a child and a grandchild are inside, the folder itself only with orSame', () => {
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d.md')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(false)
    expect(isInside('/a/b', '/a/b', { orSame: true })).toBe(true)
  })

  test('a name starting with two dots is inside', () => {
    expect(isInside('/a/b', '/a/b/..x')).toBe(true)
    expect(isInside('/a/b', '/a/b/..x/y', { orSame: true })).toBe(true)
  })

  test('the parent, a sibling, a sibling sharing the prefix and another root are outside', () => {
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/a/b', '/a', { orSame: true })).toBe(false)
    expect(isInside('/a/b', '/a/x')).toBe(false)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a/b/../c')).toBe(false)
    expect(isInside('/a/b', '/z/b/c')).toBe(false)
  })

  test('a trailing slash on either side changes nothing', () => {
    expect(isInside('/a/b/', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/b/', { orSame: true })).toBe(true)
    expect(isInside('/a/b/', '/a/b')).toBe(false)
  })
})

describe('readStringFields: a request body as string fields (#3672)', () => {
  test('reads an urlencoded body, the last of a repeated name winning', async () => {
    expect({ ...await readStringFields(post('email=a%40b.c&tag=x&tag=y', 'application/x-www-form-urlencoded')) }).toEqual({ email: 'a@b.c', tag: 'y' })
  })

  test('reads a multipart body and drops its file entries', async () => {
    const form = new FormData()
    form.set('name', 'Ada')
    form.set('avatar', new File(['png'], 'a.png'))
    expect({ ...await readStringFields(new Request('http://app.test/x', { method: 'POST', body: form })) }).toEqual({ name: 'Ada' })
  })

  test('reads a JSON object and drops what is not a string', async () => {
    const fields = await readStringFields(post('{"email":"a@b.c","age":3,"roles":["admin"],"next":null}', 'application/json'))
    expect({ ...fields }).toEqual({ email: 'a@b.c' })
  })

  test('a JSON null, array or number, and an unknown content type give no field', async () => {
    expect({ ...await readStringFields(post('null', 'application/json')) }).toEqual({})
    expect({ ...await readStringFields(post('["a","b"]', 'application/json')) }).toEqual({})
    expect({ ...await readStringFields(post('5', 'application/json')) }).toEqual({})
    expect({ ...await readStringFields(post('email=a', 'text/plain')) }).toEqual({})
  })

  test('__proto__ and constructor are kept as plain fields, on a record with no prototype', async () => {
    const form = await readStringFields(post('__proto__=p&constructor=c', 'application/x-www-form-urlencoded'))
    expect(Object.getPrototypeOf(form)).toBe(null)
    expect(Object.entries(form)).toEqual([['__proto__', 'p'], ['constructor', 'c']])
    const json = await readStringFields(post('{"__proto__":"p","constructor":"c"}', 'application/json'))
    expect(Object.entries(json)).toEqual([['__proto__', 'p'], ['constructor', 'c']])
  })

  test('a malformed JSON body throws, for the caller to answer 400', async () => {
    expect(readStringFields(post('{', 'application/json'))).rejects.toThrow()
  })
})
