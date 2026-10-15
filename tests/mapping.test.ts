import { describe, expect, it } from 'bun:test'
import { CodeBuilder } from '../src/compiler/mapping'

describe('CodeBuilder', () => {
  it('applies the rewrites inside each span copied, whatever order they were found in', () => {
    const source = 'aa bb cc dd ee'
    const rewrites = new Map([
      [9, { before: '<', after: '>', end: 11 }],
      [3, { replace: 'BB', end: 5 }],
      [6, { after: '()', end: 8 }],
      [14, { after: '!', end: 14 }],
    ])
    const builder = new CodeBuilder(source, rewrites)

    builder.addSource({ start: 0, end: 8 }).add('|').addSource({ start: 8, end: 14 }).add('|').addSource({ start: 14, end: 14 })

    expect(builder.code).toBe('aa BB cc()| <dd> ee!|!')
  })

  it('leaves out a rewrite only partly inside the span', () => {
    const builder = new CodeBuilder('abcdef', new Map([[2, { replace: 'X', end: 5 }]]))

    builder.addSource({ start: 0, end: 4 })

    expect(builder.code).toBe('abcd')
  })

  it('finds a dynamic tag by the rewrites inside its span', () => {
    const builder = new CodeBuilder('Foo Bar', new Map([[4, { before: '(', after: ')', end: 7, dynamic: true }]]))

    expect([builder.isDynamicTag({ start: 0, end: 3 }), builder.isDynamicTag({ start: 4, end: 7 })]).toEqual([false, true])
  })
})
