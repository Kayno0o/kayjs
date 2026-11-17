import { describe, expect, it } from 'bun:test'
import { s } from '../src/runtime/schema'
import { isRefusal, messagesOf, validate, validateNow } from '../src/server/validate'

const schema = s.object({
  name: s.string({ min: 2, max: 5 }),
  age: s.int({ optional: true, min: 1 }),
  agree: s.boolean({ optional: true }),
  tags: s.list(s.string(), { optional: true, max: 2 }),
  when: s.date({ optional: true }),
})

async function refusedPaths(value: unknown, source: 'form' | 'json' | 'query' | 'params' | 'env' = 'json'): Promise<string[]> {
  const result = await validate(schema, value, { source })

  return isRefusal(result) ? result.errors.map(issue => issue.path) : []
}

describe('validate', () => {
  it('words each refusal under its kay.invalid key with the limit it names', async () => {
    const result = await validate(schema, { name: 'x' }, { source: 'json' })

    expect(result).toEqual({ status: 422, errors: [{ path: 'name', key: 'kay.invalid.tooShort', params: { min: 2 }, message: 'Expected string length greater or equal to 2' }] })
  })

  it('reads text sources as numbers, booleans and lists, and a JSON body never', async () => {
    expect(await validate(schema, { name: 'ab', age: '3', agree: 'on', tags: 'a' }, { source: 'form' })).toEqual({ value: { name: 'ab', age: 3, agree: true, tags: ['a'] } })
    expect(await validate(schema, { name: 'ab', age: '3' }, { source: 'query' })).toEqual({ value: { name: 'ab', age: 3 } })
    expect(await validate(schema, { name: 'ab', age: '3' }, { source: 'params' })).toEqual({ value: { name: 'ab', age: 3 } })
    expect(await refusedPaths({ name: 'ab', age: '3' })).toEqual(['age'])
    expect(await refusedPaths({ name: 'ab', agree: 'true' })).toEqual(['agree'])
    expect(await refusedPaths({ name: 'ab', when: 5 })).toEqual(['when'])
  })

  it('accepts a real number, boolean and date in a JSON body', async () => {
    const when = new Date('2026-01-02T00:00:00Z')

    expect(await validate(schema, { name: 'ab', age: 3, agree: false, when }, { source: 'json' })).toEqual({ value: { name: 'ab', age: 3, agree: false, when } })
  })

  it('reads an exponent and refuses spaces and non-decimal forms in numeric text from a form', async () => {
    expect(await refusedPaths({ name: 'ab', age: '1e2' }, 'form')).toEqual([])
    expect(await refusedPaths({ name: 'ab', age: '0x10' }, 'form')).toEqual(['age'])
    expect(await refusedPaths({ name: 'ab', age: 'Infinity' }, 'form')).toEqual(['age'])
    expect(await refusedPaths({ name: 'ab', age: '1 2' }, 'form')).toEqual(['age'])
  })

  it('refuses a bigint and a number that is not finite', async () => {
    expect(await refusedPaths({ name: 'ab', age: 10n })).toEqual(['age'])
    expect(await refusedPaths({ name: 'ab', age: Number.NaN })).toEqual(['age'])
  })

  it('refuses an unknown key in JSON and a query, drops one a form posts, and strips one of an object that opts out', async () => {
    expect(await refusedPaths({ name: 'ab', extra: 1 })).toEqual(['extra'])
    expect(await refusedPaths({ name: 'ab', extra: 'x' }, 'query')).toEqual(['extra'])
    expect(await validate(schema, { name: 'ab', extra: 'x', go: 'Save' }, { source: 'form' })).toEqual({ value: { name: 'ab' } })
    expect(await validate(s.object({ a: s.string() }, { extra: 'strip' }), { a: 'x', b: 1 }, { source: 'json' })).toEqual({ value: { a: 'x' } })
  })

  it('drops the spaces around a form\'s text, and keeps them with trim: false', async () => {
    const line = s.object({ prefix: s.string() })

    expect(await validate(line, { prefix: ' > ' }, { source: 'form' })).toEqual({ value: { prefix: '>' } })
    expect(await validate(line, { prefix: ' > ' }, { source: 'form', trim: false })).toEqual({ value: { prefix: ' > ' } })
    expect(await validate(line, { prefix: ' > ' }, { source: 'query', trim: false })).toEqual({ value: { prefix: ' > ' } })
  })

  it('reports each place once, a list item by its index', async () => {
    const result = await validate(schema, { name: 'ab', tags: ['a', 'b', 'c'] }, { source: 'json' })

    expect(isRefusal(result) && result.errors.map(issue => [issue.path, issue.key])).toEqual([['tags', 'kay.invalid.tooManyItems']])
    expect(await refusedPaths({ name: 'ab', tags: [1] })).toEqual(['tags.0'])
  })

  it('uses an error text, a function and a record by rule', async () => {
    const worded = s.object({
      a: s.string({ min: 3, error: 'Said once' }),
      b: s.string({ min: 3, error: () => 'From a function' }),
      c: s.string({ min: 3, max: 4, error: { min: 'Say more', max: 'Say less' } }),
      d: s.string({ pattern: '^a$', error: { min: 'Not for a pattern' } }),
    })
    const result = await validate(worded, { a: 'x', b: 'x', c: 'xxxxxx', d: 'z' }, { source: 'json' })

    expect(messagesOf(isRefusal(result) ? result.errors : [])).toEqual({ a: 'Said once', b: 'From a function', c: 'Say less', d: 'Expected string to match \'^a$\'' })
  })

  it('refuses a union no branch fits, and a missing value as required', async () => {
    const union = s.object({ v: s.union([s.literal('a'), s.literal('b')]), w: s.string({ min: 1 }) })
    const result = await validate(union, { v: 'c', w: '' }, { source: 'json' })

    expect(isRefusal(result) && result.errors.map(issue => [issue.path, issue.key])).toEqual([['v', 'kay.invalid.type'], ['w', 'kay.invalid.required']])
    expect(isRefusal(await validate(union, { v: 'a' }, { source: 'json' }))).toBe(true)
  })

  it('fills a default in, in a form and a JSON body', async () => {
    const withDefault = s.object({ n: s.int({ optional: true, default: 4 }) })

    expect(await validate(withDefault, {}, { source: 'json' })).toEqual({ value: { n: 4 } })
    expect(await validate(withDefault, { n: '' }, { source: 'form' })).toEqual({ value: { n: 4 } })
  })

  it('validates now what needs no await, and refuses a Standard Schema there', () => {
    expect(validateNow(schema, { name: 'ab' }, { source: 'json' })).toEqual({ value: { name: 'ab' } })
    expect(() => validateNow({ '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } }, 1, { source: 'json' })).toThrow('validate')
  })
})

describe('each kay.invalid kind', () => {
  const kinds = s.object({
    a: s.string({ min: 3 }),
    b: s.string({ max: 2 }),
    c: s.string({ pattern: '^a$' }),
    d: s.email(),
    e: s.list(s.string(), { min: 2 }),
    f: s.list(s.string(), { max: 1 }),
    g: s.int({ min: 5 }),
    h: s.int({ max: 5 }),
    i: s.boolean(),
  })

  it('names its key and the limit it words, in a JSON body', async () => {
    const result = await validate(kinds, { a: 'x', b: 'xxx', c: 'z', d: 'no', e: ['a'], f: ['a', 'b'], g: 1, h: 9, i: 'yes' }, { source: 'json' })
    const found = isRefusal(result) ? Object.fromEntries(result.errors.map(issue => [issue.path, [issue.key, issue.params]])) : {}

    expect(found).toEqual({
      a: ['kay.invalid.tooShort', { min: 3 }],
      b: ['kay.invalid.tooLong', { max: 2 }],
      c: ['kay.invalid.pattern', {}],
      d: ['kay.invalid.format', { format: 'email' }],
      e: ['kay.invalid.tooFewItems', { min: 2 }],
      f: ['kay.invalid.tooManyItems', { max: 1 }],
      g: ['kay.invalid.tooSmall', { min: 5 }],
      h: ['kay.invalid.tooBig', { max: 5 }],
      i: ['kay.invalid.type', {}],
    })
  })
})

describe('a form with files', () => {
  const upload = s.object({ title: s.string(), photo: s.file({ optional: true }), more: s.files({ optional: true }) })

  it('reads text beside a file, and refuses a file where text is expected', async () => {
    const photo = new File(['x'], 'a.png', { type: 'image/png' })

    expect(await validate(upload, { title: 'a', photo }, { source: 'form' })).toEqual({ value: { title: 'a', photo } })
    expect(isRefusal(await validate(upload, { title: photo }, { source: 'form' }))).toBe(true)
  })
})

describe('validate with a Standard Schema validator', () => {
  const standard = (jsonSchema?: object) => ({
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => {
        const input = value as { age?: unknown }

        return typeof input.age === 'number' ? { value: input } : { issues: [{ message: 'age is a number', path: ['age'] }] }
      },
      ...jsonSchema !== undefined && { jsonSchema: { input: () => jsonSchema } },
    },
  })

  it('validates through ~standard.validate and words its issues by dotted path', async () => {
    expect(await validate(standard(), { age: 3 }, { source: 'json' })).toEqual({ value: { age: 3 } })
    expect(await validate(standard(), { age: 'x' }, { source: 'json' })).toEqual({ status: 422, errors: [{ path: 'age', key: 'kay.invalid.type', params: {}, message: 'age is a number' }] })
  })

  it('reads a text source by the JSON Schema it describes itself with', async () => {
    const described = standard({ type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] })

    expect(await validate(described, { age: '3' }, { source: 'form' })).toEqual({ value: { age: 3 } })
    expect(isRefusal(await validate(described, { age: '3' }, { source: 'json' }))).toBe(true)
    expect(isRefusal(await validate(standard(), { age: '3' }, { source: 'form' }))).toBe(true)
  })

  it('awaits an async validator', async () => {
    const later = { '~standard': { version: 1 as const, vendor: 'test', validate: async () => ({ value: 7 }) } }

    expect(await validate(later, 1, { source: 'json' })).toEqual({ value: 7 })
  })
})
