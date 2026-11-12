import { expect, it } from 'bun:test'
import { persisted, s } from '../src/runtime'
import { readParam } from '../src/runtime/query-param'
import { queryRules, readQuery } from '../src/server/query'
import { inServerScope } from '../src/server/scope'

// No DOM is registered here, so the signals read as they do while a request renders.
const schema = s.Object({
  tags: s.Array(s.String(), { default: ['a'] }),
  nums: s.Array(s.Number(), { default: [1] }),
  q: s.String({ default: 'x' }),
})
const rules = queryRules(schema)
const render = <T>(search: string, run: () => T, withRules = false) => inServerScope(new Request(`http://localhost/page${search}`), () => undefined, run, undefined, withRules ? rules : undefined)

it('reads a blank list or string the same on the server and in the browser, a field with a default included', () => {
  const url = new URL('http://localhost/page?tags=&nums=&q=')
  const query = readQuery(schema, url)

  expect(query).toEqual({ tags: [], nums: [], q: '' })

  for (const name of ['tags', 'nums', 'q'])
    expect(readParam(rules, name, url.searchParams)).toEqual(query[name])
})

it('leaves a param out as its default on both sides', () => {
  const url = new URL('http://localhost/page')

  expect(readQuery(schema, url)).toEqual({ tags: ['a'], nums: [1], q: 'x' })
  expect(readParam(rules, 'tags', url.searchParams)).toEqual(['a'])
})

it('renders persisted.query with numeric values and a blank list from the request, with no schema naming them', () => {
  expect(render('?page=2', () => persisted.query('page', 1, { values: [1, 2, 3] })())).toBe(2)
  expect(render('?page=9', () => persisted.query('page', 1, { values: [1, 2, 3] })())).toBe(1)
  expect(render('?tags=', () => persisted.query<string[]>('tags', ['a'])())).toEqual([])
  expect(render('?q=', () => persisted.query('q', 'x')())).toBe('')
})

it('renders persisted.query on a schema page as the server reads the query', () => {
  expect(render('?tags=&nums=&q=', () => [persisted.query<string[]>('tags', ['a'])(), persisted.query<number[]>('nums', [1])(), persisted.query('q', 'x')()], true)).toEqual([[], [], ''])
})

it('reads a blank optional field as left out on both sides, its default filling in', () => {
  const optional = s.Object({ q: s.Optional(s.String({ default: 'x' })), r: s.Optional(s.String()) })
  const url = new URL('http://localhost/page?q=&r=')

  expect(readQuery(optional, url)).toEqual({ q: 'x' })
  expect(readParam(queryRules(optional), 'q', url.searchParams)).toBe('x')
  expect(readParam(queryRules(optional), 'r', url.searchParams)).toBeUndefined()
})
