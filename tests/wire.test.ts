import { describe, expect, it } from 'bun:test'
import { parse, stringify } from 'devalue'
import { sendValue } from '../src/runtime/send'
import { decodeValue, unflattenValue } from '../src/runtime/wire'

const MALFORMED = /^kay: the devalue text received is malformed at index/

// Through devalue's stringify, as the server writes it, and kay's decoder, as the browser reads it.
function roundTrip(value: unknown): unknown {
  return decodeValue(stringify(value))
}

// An array of `length` with only the given entries set, the others left as holes.
function holed(length: number, entries: Record<number, unknown>): unknown[] {
  const array: unknown[] = []

  array.length = length

  for (const [index, value] of Object.entries(entries))
    array[Number(index)] = value

  return array
}

// Every kind of value an island prop, an action call or a persisted signal may hold.
const VALUES: unknown[] = [
  { name: 'kay', count: 3, ok: true, none: null, nested: { list: [1, 'two', [3]] } },
  [],
  {},
  '',
  'text with "quotes", </script> and \u2028\u2029',
  0,
  -12.5,
  true,
  null,
  undefined,
  Number.NaN,
  Infinity,
  -Infinity,
  new Date('2026-10-04T21:01:00.000Z'),
  new Map<unknown, unknown>([['a', 1], [{ key: true }, [2]]]),
  new Set([1, 'two', { three: 3 }]),
  123_456_789_012_345_678_901_234_567_890n,
  -5n,
  new URL('https://example.com/a?b=c#d'),
  /^a.b$/,
  /x\/y/giu,
  { missing: undefined, list: [undefined, Number.NaN] },
  holed(3, { 0: 1, 2: 3 }),
  holed(2, {}),
  holed(1_000_001, { 1_000_000: 'last' }),
  Object.assign(Object.create(null) as object, { a: 1, b: { c: 2 } }),
]

describe('a value round trips', () => {
  // Written by devalue as the server does, or by kay's own writer as the browser does; read by kay's decoder and by devalue's parse.
  it.each(VALUES.map(value => [value]))('through both writers and both readers: %p', (value) => {
    const decoded = roundTrip(value)

    expect(decoded).toStrictEqual(value)
    // Written again, it must come out as devalue's own parse would have rebuilt it.
    expect(stringify(decoded)).toBe(stringify(parse(stringify(value))))

    const sent = sendValue(value)

    expect(decodeValue(sent)).toStrictEqual(value)
    expect(parse(sent)).toStrictEqual(value)
  })
})

describe('kay decodes devalue text', () => {
  // Apart from the others, since Bun's toStrictEqual never finds two Invalid Dates or two URLSearchParams equal.
  it('reads back an invalid Date and URLSearchParams', () => {
    const date = roundTrip(new Date(Number.NaN))
    const search = roundTrip(new URLSearchParams('a=1&b=two&a=3'))

    expect(date).toBeInstanceOf(Date)
    expect((date as Date).getTime()).toBeNaN()
    expect(search).toBeInstanceOf(URLSearchParams)
    expect(String(search)).toBe('a=1&b=two&a=3')
  })

  it('keeps -0 apart from 0', () => {
    const [negative, positive] = roundTrip([-0, 0]) as number[]

    expect(Object.is(roundTrip(-0), -0)).toBe(true)
    expect(Object.is(negative, -0)).toBe(true)
    expect(Object.is(positive, 0)).toBe(true)
  })

  it('keeps holes as holes', () => {
    const decoded = roundTrip(holed(3, { 0: 1, 2: 3 })) as unknown[]

    expect(decoded).toHaveLength(3)
    expect(1 in decoded).toBe(false)
  })

  it('keeps a value shared between two places as one value', () => {
    const shared = { id: 1 }
    const decoded = roundTrip({ a: shared, b: [shared], c: new Map([[shared, shared]]) }) as { a: object, b: object[], c: Map<object, object> }

    expect(decoded.b[0]).toBe(decoded.a)
    expect([...decoded.c.keys()][0]).toBe(decoded.a)
    expect([...decoded.c.values()][0]).toBe(decoded.a)
  })

  it('rebuilds cyclic references', () => {
    const object: Record<string, unknown> = { name: 'root' }
    const list: unknown[] = [object]
    const map = new Map<string, unknown>()
    const set = new Set<unknown>()

    object.self = object
    object.list = list
    list.push(list)
    map.set('map', map)
    set.add(set)

    const decoded = roundTrip({ object, map, set }) as { object: typeof object, map: typeof map, set: typeof set }

    expect(decoded.object.self).toBe(decoded.object)
    expect((decoded.object.list as unknown[])[0]).toBe(decoded.object)
    expect((decoded.object.list as unknown[])[1]).toBe(decoded.object.list)
    expect(decoded.map.get('map')).toBe(decoded.map)
    expect([...decoded.set][0]).toBe(decoded.set)
  })

  it('revives a custom type from what its reducer returned', () => {
    class Point {
      constructor(readonly x: number, readonly y: number) {}
    }

    const point = new Point(1, 2)
    const text = stringify({ a: point, b: point }, { Point: value => value instanceof Point && [value.x, value.y] })
    const revivers = { Point: ([x, y]: [number, number]) => new Point(x, y) }
    const decoded = decodeValue(text, revivers) as { a: Point, b: Point }

    expect(decoded.a).toBeInstanceOf(Point)
    expect(decoded.a).toStrictEqual(point)
    expect(decoded.b).toBe(decoded.a)
    expect(unflattenValue(JSON.parse(text), revivers)).toStrictEqual({ a: point, b: point })
  })

  it('takes a forged sparse length of 2 ** 32 - 1 without allocating its slots', () => {
    const decoded = decodeValue('[[-7,4294967295,4294967294,1],"last"]') as unknown[]

    expect(decoded).toHaveLength(4294967295)
    expect(decoded[4294967294]).toBe('last')
    expect(Object.keys(decoded)).toEqual(['4294967294'])
  })

  it('reads a top-level constant', () => {
    expect(unflattenValue(-1)).toBeUndefined()
    expect(unflattenValue(-3)).toBeNaN()
  })
})

describe('the browser writes devalue text itself', () => {
  it('writes a Date, an invalid one, URLSearchParams and -0', () => {
    const [date, invalid, search, zero] = decodeValue(sendValue([new Date('2026-10-06'), new Date(Number.NaN), new URLSearchParams('a=1&a=2'), -0])) as [Date, Date, URLSearchParams, number]

    expect(date.toISOString()).toBe('2026-10-06T00:00:00.000Z')
    expect(invalid.getTime()).toBeNaN()
    expect((parse(sendValue(new Date(Number.NaN))) as Date).getTime()).toBeNaN()
    expect(String(search)).toBe('a=1&a=2')
    expect(Object.is(zero, -0)).toBe(true)
    expect(Object.is(decodeValue(sendValue(-0)), -0)).toBe(true)
  })

  it('writes a shared or cyclic value once', () => {
    const shared = { id: 1 }
    const object: Record<string, unknown> = { shared, again: shared }
    const map = new Map<string, unknown>()

    object.self = object
    map.set('map', map)

    const decoded = decodeValue(sendValue({ object, map })) as { object: typeof object, map: typeof map }

    expect(decoded.object.again).toBe(decoded.object.shared)
    expect(decoded.object.self).toBe(decoded.object)
    expect(decoded.map.get('map')).toBe(decoded.map)
  })

  it('writes a far index of a sparse array without its holes', () => {
    const text = sendValue(holed(1_000_001, { 1_000_000: 'last' }))

    expect(text).toBe('[[-7,1000001,1000000,1],"last"]')
  })

  it('leaves out a holed array\'s properties that are no canonical index', () => {
    const array = Object.assign(holed(3, { 0: 1 }), { '01': 'a', '1e0': 'b' })

    expect(decodeValue(sendValue(array))).toStrictEqual(holed(3, { 0: 1 }))
  })

  it('writes a custom type through its reducer', () => {
    const blob = new Blob(['x'])
    const files: Blob[] = []
    const text = sendValue({ a: blob, b: blob }, { File: value => value instanceof Blob && [files.push(value) - 1] })
    const decoded = decodeValue(text, { File: ([index]: [number]) => files[index] }) as { a: Blob, b: Blob }

    expect(files).toEqual([blob])
    expect(decodeValue(sendValue({ none: 0 }, { File: () => 0 }))).toStrictEqual({ none: 0 })
    expect(decoded.a).toBe(blob)
    expect(decoded.b).toBe(blob)
  })

  it('refuses what neither reader rebuilds', () => {
    class Point {
      constructor(readonly x: number) {}
    }

    const proto = JSON.parse('{"__proto__":1}') as object

    expect(() => sendValue({ format: () => 'x' })).toThrow('kay: a function cannot be sent')
    expect(() => sendValue([Symbol('x')])).toThrow('kay: a symbol cannot be sent')
    expect(() => sendValue(new Point(1))).toThrow('kay: an instance of Point cannot be sent')
    expect(() => sendValue(new Uint8Array(1))).toThrow('kay: an instance of Uint8Array cannot be sent')
    expect(() => sendValue({ [Symbol('x')]: 1 })).toThrow('kay: an object with symbol keys cannot be sent')
    expect(() => sendValue(proto)).toThrow('kay: an object with a __proto__ key cannot be sent')
  })
})

describe('kay refuses a malformed payload', () => {
  const cases: [string, string, Record<string, (value: never) => unknown>?][] = [
    ['an empty list', '[]'],
    ['a bare object', '{}'],
    ['a bare string', '"text"'],
    ['an unknown constant', '-9'],
    ['an index past the end', '[[1]]'],
    ['a fractional index', '[[0.5]]'],
    ['an index that is not a number', '[{"a":"1"},2]'],
    ['an unknown constant inside', '[[-8]]'],
    ['a type kay never sends', '[["Uint8Array",1],["ArrayBuffer","AAAA"]]'],
    ['a boxed primitive', '[["Object",1],2]'],
    ['a Date that is not a string', '[["Date",5]]'],
    ['a RegExp with flags that are not a string', '[["RegExp","a",1]]'],
    ['a __proto__ key', '[{"__proto__":1},{"polluted":2},3]'],
    ['a __proto__ key on a null-prototype object', '[["null","__proto__",1],{}]'],
    ['a null-prototype key that is not a string', '[["null",1,1],2]'],
    ['a sparse array with a negative length', '[[-7,-1]]'],
    ['a sparse array with a length too long', '[[-7,4294967296]]'],
    ['a sparse array index past its length', '[[-7,2,5,1],"x"]'],
    ['a revived type containing itself', '[["Custom",0]]', { Custom: value => value }],
  ]

  for (const [name, text, revivers] of cases) {
    it(`such as ${name}`, () => {
      expect(() => decodeValue(text, revivers)).toThrow(MALFORMED)
    })
  }

  it('such as text that is not JSON', () => {
    expect(() => decodeValue('{not json')).toThrow(SyntaxError)
  })

  it('such as a URL or a bigint that does not parse', () => {
    expect(() => decodeValue('[["URL","not a url"]]')).toThrow(TypeError)
    expect(() => decodeValue('[["BigInt","1.5"]]')).toThrow(SyntaxError)
  })
})
