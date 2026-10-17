import type { CollectionInfo, ScreenCollection } from '../src/kay/contract'
import { describe, expect, test } from 'bun:test'
import { fieldsOf } from '../src/fields'
import { cellText, checkLayouts, formRows, layoutProblems, listColumns, rowActions } from '../src/layout'
import { rowsOf } from '../src/listing'
import { configure, settings } from '../src/settings'

const schema = {
  required: ['name'],
  properties: {
    name: { type: 'string' },
    price: { type: 'number' },
    stock: { type: 'integer' },
    live: { type: 'boolean' },
    photo: { 'type': 'string', 'x-kay': { kind: 'image' } },
    kind: { enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
    title: { type: 'string' },
    actions: { type: 'string' },
  },
}
const fields = fieldsOf(schema)
const keys = (rows: ReturnType<typeof formRows>) => rows.map(row => row.map(item => item === 'body' ? '#body' : item.key))

describe('formRows', () => {
  test('keeps the schema order and puts the body last without a layout', () => {
    expect(keys(formRows(fields, true))).toEqual([['name'], ['price'], ['stock'], ['live'], ['photo'], ['kind'], ['tags'], ['title'], ['actions'], ['#body']])
    expect(keys(formRows(fields, false)).flat()).not.toContain('#body')
  })

  test('shows the named fields first, a nested list being a row, the others after', () => {
    const rows = formRows(fields, true, { fields: ['photo', ['price', 'stock'], 'body'] })

    expect(keys(rows).slice(0, 4)).toEqual([['photo'], ['price', 'stock'], ['#body'], ['name']])
    expect(keys(rows).flat()).toHaveLength(10)
  })

  test('hides a field, the body included, and shows no name twice or unknown', () => {
    const rows = keys(formRows(fields, true, { fields: ['price', ['price', 'nope', '__proto__', 'constructor']], hide: ['tags', 'body', 'stock'] })).flat()

    expect(rows.filter(key => key === 'price')).toHaveLength(1)
    expect(rows).not.toContain('tags')
    expect(rows).not.toContain('stock')
    expect(rows).not.toContain('#body')
    expect(rows).not.toContain('nope')
    expect(rows).toHaveLength(7)
  })

  test('reads body as a data field when the schema has one, and #body as the body', () => {
    const own = fieldsOf({ properties: { body: { type: 'string' }, name: { type: 'string' } } })

    expect(keys(formRows(own, true, { fields: ['#body', 'body'] }))).toEqual([['#body'], ['body'], ['name']])
    expect(keys(formRows(own, true, { hide: ['body'] }))).toEqual([['name'], ['#body']])
  })
})

describe('listColumns and cellText', () => {
  test('keeps the named fields once, of a kind a cell can show, the schema\'s own title and actions fields included', () => {
    expect(listColumns(fields, { columns: ['price', 'tags', 'price', 'nope', 'title', 'actions', '__proto__'] }).map(field => field.key)).toEqual(['price', 'title', 'actions'])
    expect(listColumns(fields)).toEqual([])
  })

  test('writes a value as short text', () => {
    const [name, price, , live, photo, kind] = fields as [typeof fields[number], ...typeof fields]

    expect(cellText(live!, true)).toBe('✓')
    expect(cellText(live!, false)).toBe('')
    expect(cellText(price!, 12.5)).toBe('12.5')
    expect(cellText(photo!, '/_kay/files/products/a%20b.png')).toBe('a%20b.png')
    expect(cellText(kind!, 'a')).toBe('a')
    expect(cellText(name, null)).toBe('')
    expect(cellText(name, { evil: 1 })).toBe('')
    expect(cellText(name, '<script>x</script>\n  y')).toBe('<script>x</script> y')
    expect(cellText(name, 'x'.repeat(500))).toHaveLength(80)
  })

  test('is a select option\'s label, a date its day', () => {
    const [choice] = fieldsOf({ properties: { size: { anyOf: [{ const: 1, title: 'Small' }, { const: 2, title: 'Large' }] }, day: { type: 'string', format: 'date' } } })
    const day = fieldsOf({ properties: { day: { type: 'string', format: 'date' } } })[0]!

    expect(cellText(choice!, 2)).toBe('Large')
    expect(cellText(day, '2026-10-17T10:00:00Z')).toBe('2026-10-17')
  })
})

describe('rowActions', () => {
  test('are all four unless the layout names some', () => {
    expect([...rowActions()]).toEqual(['move', 'publish', 'editOnPage', 'delete'])
    expect([...rowActions({ actions: ['delete'] })]).toEqual(['delete'])
    expect([...rowActions({ actions: [] })]).toEqual([])
  })
})

describe('checkLayouts', () => {
  test('reads a layout as given, none as none', () => {
    expect(checkLayouts(undefined).size).toBe(0)
    expect(checkLayouts({ products: { form: { fields: ['name', ['price', 'stock']], hide: ['tags'] }, list: { columns: ['price'], actions: ['delete'] } } }).get('products')).toEqual({ form: { fields: ['name', ['price', 'stock']], hide: ['tags'] }, list: { columns: ['price'], actions: ['delete'] } })
  })

  test('keeps a collection named __proto__ as a collection', () => {
    expect(checkLayouts(JSON.parse('{"__proto__":{"list":{"columns":["a"]}}}')).get('__proto__')).toEqual({ form: undefined, list: { columns: ['a'], actions: undefined } })
  })

  test('refuses, as kay.config.ts loads, what no layout can mean', () => {
    const refused = (value: unknown) => () => checkLayouts(value)

    expect(refused([])).toThrow('takes an object')
    expect(refused({ a: 'x' })).toThrow('takes an object')
    expect(refused({ a: { form: { fields: 'name' } } })).toThrow('fields')
    expect(refused({ a: { form: { fields: [['a', ['b']]] } } })).toThrow('list of field names')
    expect(refused({ a: { form: { fields: [1] } } })).toThrow('list of field names')
    expect(refused({ a: { form: { fields: ['a', ['a']] } } })).toThrow('twice')
    expect(refused({ a: { form: { fields: ['a'], hide: ['a'] } } })).toThrow('both shows and hides')
    expect(refused({ a: { form: { hide: [''] } } })).toThrow('list of field names')
    expect(refused({ a: { list: { columns: ['a', 'a'] } } })).toThrow('twice')
    expect(refused({ a: { list: { actions: ['remove'] } } })).toThrow('the row actions are')
  })
})

describe('layoutProblems', () => {
  const products: CollectionInfo = { name: 'products', kind: 'folder', localized: false, components: [], schema }

  test('names what the schemas lack and what a cell cannot show', () => {
    const layouts = checkLayouts({ products: { form: { fields: ['name', 'nope'], hide: ['body', 'gone'] }, list: { columns: ['price', 'tags', 'absent'] } }, ghosts: {} })

    expect(layoutProblems([products], layouts)).toEqual([
      'products\'s form names nope, which its schema lacks',
      'products\'s form names gone, which its schema lacks',
      'products\'s list names the column tags, a list field a cell cannot show',
      'products\'s list names the column absent, which its schema lacks',
      'cms({ collections }) names ghosts, which is no collection of the site',
    ])
    expect(layoutProblems([products], checkLayouts({ products: { form: { fields: ['name', ['price']] } } }))).toEqual([])
  })
})

describe('cms({ collections })', () => {
  test('is checked when set up, and reaches the settings', () => {
    expect(() => configure({ collections: { products: { list: { actions: ['x' as never] } } } })).toThrow('the row actions are')
    configure({ collections: { products: { list: { columns: ['price'] } } } })
    expect(settings().layouts.get('products')?.list?.columns).toEqual(['price'])
  })
})

describe('rowsOf with columns', () => {
  const products: ScreenCollection = { name: 'products', kind: 'folder', localized: false, components: [], schema, layout: { list: { columns: ['price', 'live', 'title'] } } }

  test('carries the cells of the chosen columns only, never a field\'s value a cell cannot show', () => {
    const [row] = rowsOf(products, [{ slug: 'a', data: { name: 'A', price: 3, live: true, tags: ['x'], title: 'T' }, draft: false }])

    expect(row?.cells).toEqual({ price: '3', live: '✓', title: 'T' })
    expect(rowsOf({ ...products, layout: undefined }, [{ slug: 'a', data: { name: 'A' }, draft: false }])[0]?.cells).toBeUndefined()
  })
})
