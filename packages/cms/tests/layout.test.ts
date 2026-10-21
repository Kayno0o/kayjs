import type { ToolbarAction as UiToolbarAction } from '../../ui/src/markdown-edit'
import type { CollectionInfo, ScreenCollection, ToolbarAction } from '../src/kay/contract'
import { describe, expect, test } from 'bun:test'
import { TOOLBAR_ACTIONS } from '../../ui/src/markdown-edit'
import { fieldsOf } from '../src/fields'
import { bodylessLayout, cellText, checkLayouts, formRows, layoutProblems, listColumns, rowActions, TOOLBAR_BUTTONS, whenProblems } from '../src/layout'
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

describe('formRows with dotted names', () => {
  const nested = fieldsOf({
    properties: {
      name: { type: 'string' },
      address: { type: 'object', properties: { street: { type: 'string' }, city: { type: 'string' }, geo: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } } } },
    },
  })
  const placed = (rows: ReturnType<typeof formRows>) => rows.map(row => row.map(item => item === 'body' ? '#body' : item.at ?? item.key))
  const inside = (rows: ReturnType<typeof formRows>) => {
    const group = rows.flat().find(item => item !== 'body' && item.key === 'address')

    return group !== undefined && group !== 'body' && group.kind === 'group' ? group.fields.map(field => field.key) : undefined
  }

  test('places a nested field in a row, the group keeping the others', () => {
    const rows = formRows(nested, false, { fields: [['name', 'address.city']] })

    expect(placed(rows)).toEqual([['name', 'address.city'], ['address']])
    expect(inside(rows)).toEqual(['street', 'geo'])
    expect(rows[0]![1]).toMatchObject({ key: 'city', at: 'address.city' })
  })

  test('hides a nested field, a group left empty, and everything under a hidden group', () => {
    expect(inside(formRows(nested, false, { hide: ['address.street'] }))).toEqual(['city', 'geo'])
    expect(placed(formRows(nested, false, { hide: ['address.street', 'address.city', 'address.geo'] }))).toEqual([['name']])
    expect(placed(formRows(nested, false, { fields: ['address.street'], hide: ['address'] }))).toEqual([['name']])
  })

  test('reaches two levels down, and shows a path once', () => {
    const rows = formRows(nested, false, { fields: ['address.geo.lat', 'address.geo.lat'] })

    expect(placed(rows)[0]).toEqual(['address.geo.lat'])
    expect(placed(rows).flat().filter(id => id === 'address.geo.lat')).toHaveLength(1)
    expect(inside(rows)).toEqual(['street', 'city', 'geo'])
  })

  test('skips a path the schema lacks, a list index and a path through a plain field', () => {
    expect(placed(formRows(nested, false, { fields: ['address.zip', 'name.first', 'address.__proto__'] }))).toEqual([['name'], ['address']])
  })

  test('reports a path the schema lacks like a top-level name', () => {
    const collection: CollectionInfo = { name: 'people', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { address: { type: 'object', properties: { city: { type: 'string' } } } } } }
    const layouts = checkLayouts({ people: { form: { fields: ['address.city', 'address.zip'], hide: ['address.nope.x'] } } })

    expect(layoutProblems([collection], layouts)).toEqual(['people\'s form names address.zip, which its schema lacks', 'people\'s form names address.nope.x, which its schema lacks'])
  })
})

describe('listColumns and cellText', () => {
  test('keeps the named fields once, of a kind a cell can show, the schema\'s own title and actions fields included', () => {
    expect(listColumns(fields, { columns: ['price', 'tags', 'price', 'nope', 'title', 'actions', '__proto__'] }).map(field => field.key)).toEqual(['price', 'title', 'actions'])
    expect(listColumns(fields)).toEqual([])
  })

  test('writes a value as short text', () => {
    const [name, price, , live, photo, kind] = fields as [typeof fields[number], ...typeof fields]

    expect(cellText(live!, true)).toBe('Yes')
    expect(cellText(live!, false)).toBe('No')
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
  test('are all seven unless the layout names some', () => {
    expect([...rowActions()]).toEqual(['move', 'publish', 'unpublish', 'duplicate', 'rename', 'editOnPage', 'delete'])
    expect([...rowActions({ actions: ['delete'] })]).toEqual(['delete'])
    expect([...rowActions({ actions: [] })]).toEqual([])
  })
})

describe('the form\'s Markdown settings', () => {
  test('are checked as the config loads, and name the buttons kayjs-ui has', () => {
    // Each name of one list types as a name of the other.
    const fromUi: ToolbarAction[] = [...TOOLBAR_ACTIONS]
    const fromCms: UiToolbarAction[] = [...TOOLBAR_BUTTONS]

    expect(fromCms).toEqual(fromUi)
    expect(checkLayouts({ posts: { form: { body: { label: 'Article', hint: 'Plain text' }, toolbar: ['bold', 'link'] } } }).get('posts')?.form).toMatchObject({ body: { label: 'Article', hint: 'Plain text' }, toolbar: ['bold', 'link'] })
    expect(checkLayouts({ posts: { form: { toolbar: false } } }).get('posts')?.form?.toolbar).toBe(false)
    expect(() => checkLayouts({ posts: { form: { toolbar: ['bold', 'underline'] } } })).toThrow('underline')
    expect(() => checkLayouts({ posts: { form: { toolbar: ['bold', 'bold'] } } })).toThrow('twice')
    expect(() => checkLayouts({ posts: { form: { toolbar: 'bold' } } })).toThrow('takes true, false or a list of buttons')
    expect(() => checkLayouts({ posts: { form: { toolbar: [''] } } })).toThrow('the buttons are')
    expect(checkLayouts({ posts: { form: { toolbar: true } } }).get('posts')?.form?.toolbar).toBe(true)
    expect(checkLayouts({ posts: { form: { previewClass: 'prose' } } }).get('posts')?.form?.previewClass).toBe('prose')
    expect(() => checkLayouts({ posts: { form: { previewClass: ' ' } } })).toThrow('previewClass')
    expect(() => checkLayouts({ posts: { form: { previewClass: ['prose'] } } })).toThrow('posts')
    expect(() => checkLayouts({ posts: { form: { body: { label: ' ' } } } })).toThrow('label')
    expect(() => checkLayouts({ posts: { form: { body: { title: 'x' } } } })).toThrow('title')
  })
})

describe('checkLayouts', () => {
  test('reads the group and the order of the content list, and refuses what means nothing', () => {
    expect(checkLayouts({ posts: { group: 'Blog', order: 2 } }).get('posts')).toMatchObject({ group: 'Blog', order: 2 })
    expect(() => checkLayouts({ posts: { group: '  ' } })).toThrow('group')
    expect(() => checkLayouts({ posts: { order: '1' } })).toThrow('order')
    expect(() => checkLayouts({ posts: { order: Number.NaN } })).toThrow('order')
  })

  test('reads an icon for the content list and refuses what is not one', () => {
    const icon = { 'viewBox': '0 0 24 24', 'width': '1em', 'height': '1em', 'aria-hidden': 'true', 'innerHTML': '<path d="M0 0"/>' }

    expect(checkLayouts({ posts: { icon } }).get('posts')?.icon).toBe(icon as never)
    expect(() => checkLayouts({ posts: { icon: 'home' } })).toThrow('icon')
    expect(() => checkLayouts({ posts: { icon: {} } })).toThrow('icon')
  })

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
    expect(refused({ a: { forms: {} } })).toThrow('has no option "forms"')
    expect(refused({ a: { form: { hidden: ['x'] } } })).toThrow('it takes fields, hide')
    expect(refused({ a: { list: { column: ['x'] } } })).toThrow('it takes columns, actions')
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

describe('an image\'s paired fields', () => {
  const shop: CollectionInfo = { name: 'shop', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties: { photo: { 'type': 'string', 'x-kay': { kind: 'image', alt: 'caption', width: 'w' } }, caption: { type: 'string' }, w: { type: 'integer' }, name: { type: 'string' } } } }

  test('are told apart from fields the schema lacks when a form names them', () => {
    expect(layoutProblems([shop], checkLayouts({ shop: { form: { fields: ['caption', 'nope'] } } }))).toEqual([
      'shop\'s form names caption, which is the alt of its image photo: the form shows it there',
      'shop\'s form names nope, which its schema lacks',
    ])
  })

  test('can still be columns of a list', () => {
    const fields = fieldsOf(shop.schema)

    expect(listColumns(fields, { columns: ['name', 'caption', 'w'] }).map(field => field.key)).toEqual(['name', 'caption', 'w'])
    expect(layoutProblems([shop], checkLayouts({ shop: { list: { columns: ['caption', 'w'] } } }))).toEqual([])
  })
})

describe('whenProblems', () => {
  const when = (key: string) => ({ 'type': 'string', 'x-kay-input': { when: key } })
  const page = (properties: Record<string, unknown>): CollectionInfo => ({ name: 'pages', kind: 'folder', localized: false, components: [], schema: { type: 'object', properties } as CollectionInfo['schema'] })

  test('names a field waiting for a key that is no sibling, at the top, in a group and in a list of groups', () => {
    const lines = whenProblems([page({
      url: { type: 'string' },
      label: when('url'),
      alt: when('nope'),
      link: { type: 'object', properties: { href: { type: 'string' }, text: when('url') } },
      links: { type: 'array', items: { type: 'object', properties: { href: { type: 'string' }, text: when('href'), extra: when('url') } } },
    })])

    expect(lines).toEqual([
      'pages: alt waits for nope (fieldInput `when`), which is no field beside it, so it stays hidden',
      'pages: link.text waits for url (fieldInput `when`), which is no field beside it, so it stays hidden',
      'pages: links.extra waits for url (fieldInput `when`), which is no field beside it, so it stays hidden',
    ])
  })

  test('names the block a waiting field is in', () => {
    const block = (type: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { type: { type: 'string', const: type }, ...properties } })
    const sections = { 'type': 'array', 'x-kay': { kind: 'blocks' }, 'items': { anyOf: [block('hero', { href: { type: 'string' }, text: when('href') }), block('text', { text: when('href') })] } }

    expect(whenProblems([page({ sections })])).toEqual(['pages: sections[text].text waits for href (fieldInput `when`), which is no field beside it, so it stays hidden'])
  })

  test('counts the alt text an image takes as a sibling', () => {
    const lines = whenProblems([page({
      photo: { 'type': 'string', 'x-kay': { kind: 'image', alt: 'alt' } },
      alt: { type: 'string' },
      caption: when('alt'),
    })])

    expect(lines).toEqual([])
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

    expect(row?.cells).toEqual({ price: '3', live: 'Yes', title: 'T' })
    expect(rowsOf({ ...products, layout: undefined }, [{ slug: 'a', data: { name: 'A' }, draft: false }])[0]?.cells).toBeUndefined()
  })
})

describe('bodylessLayout', () => {
  const posts: CollectionInfo = { name: 'posts', kind: 'folder', localized: false, components: [], schema, body: { kind: 'markdown' } }
  const tags: CollectionInfo = { name: 'tags', kind: 'folder', localized: false, components: [], schema }

  test('names a collection whose body is worded though it has none, and lets a collection with one through', () => {
    const layouts = checkLayouts({ posts: { form: { body: { label: 'Article' } } }, tags: { form: { body: { hint: 'Never shown' } } } })

    expect(bodylessLayout([posts], layouts)).toBeUndefined()
    expect(bodylessLayout([posts, tags], layouts)).toContain('`tags.form.body`')
    expect(bodylessLayout([tags], checkLayouts({ tags: { form: { toolbar: false } } }))).toBeUndefined()
  })
})
