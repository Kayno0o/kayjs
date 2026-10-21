import type { Static } from 'elysia'
import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { TypeCompiler } from 'elysia/type-system'
import { blocks, collection } from '../src/content'
import { dataIssues, withDefaults } from '../src/content/validate'

const sections = blocks({
  hero: t.Object({ heading: t.String({ minLength: 1 }), image: t.Optional(t.String()) }, { title: 'Hero banner' }),
  text: t.Object({ body: t.String() }),
  gallery: t.Object({ images: t.Array(t.String()) }),
})
const page = t.Object({ title: t.String(), sections })

describe('blocks', () => {
  it('stores each item with its type key and checks it against its own type', () => {
    const check = TypeCompiler.Compile(sections)

    expect(check.Check([{ type: 'hero', heading: 'Hi' }, { type: 'text', body: 'x' }, { type: 'gallery', images: ['/a.png'] }])).toBe(true)
    expect(check.Check([])).toBe(true)
    expect(check.Check([{ type: 'hero' }])).toBe(false)
    expect(check.Check([{ type: 'hero', heading: '' }])).toBe(false)
    expect(check.Check([{ type: 'text', heading: 'Hi' }])).toBe(false)
    expect(check.Check([{ type: 'video', body: 'x' }])).toBe(false)
    expect(check.Check([{ heading: 'Hi' }])).toBe(false)
  })

  it('reports its kind and one object per type in JSON Schema', () => {
    const schema = JSON.parse(JSON.stringify(sections)) as { 'x-kay': unknown, 'items': { anyOf: { title?: string, properties: Record<string, unknown>, required: string[] }[] } }

    expect(schema['x-kay']).toEqual({ kind: 'blocks' })
    expect(schema.items.anyOf.map(variant => variant.properties.type)).toEqual([{ type: 'string', const: 'hero' }, { type: 'string', const: 'text' }, { type: 'string', const: 'gallery' }])
    expect(schema.items.anyOf[0]?.title).toBe('Hero banner')
    expect(schema.items.anyOf[0]?.required).toEqual(['type', 'heading'])
  })

  it('names the field of the block that fails, not the item', () => {
    expect(dataIssues(page, { title: 'x', sections: [{ type: 'hero', heading: '' }, { type: 'text' }] }).map(issue => issue.path)).toEqual(['sections.0.heading', 'sections.1.body'])
    expect(dataIssues(page, { title: 'x', sections: [{ type: 'video' }, {}] }).map(issue => issue.path)).toEqual(['sections.0', 'sections.1'])
  })

  it('fills the defaults of a block by its type, however deep', () => {
    const rows = t.Object({ rows: blocks({ cell: t.Object({ align: t.String({ default: 'left' }), tags: t.Array(t.Object({ tone: t.String({ default: 'plain' }) })) }), gap: t.Object({ size: t.Number({ default: 2 }) }) }) })

    expect(withDefaults({ rows: [{ type: 'cell', tags: [{}] }, { type: 'gap' }, { type: 'gap', size: 5 }, { type: 'zzz' }, 'x'] }, rows)).toEqual({ rows: [{ type: 'cell', align: 'left', tags: [{ tone: 'plain' }] }, { type: 'gap', size: 2 }, { type: 'gap', size: 5 }, { type: 'zzz' }, 'x'] })
    expect(dataIssues(rows, { rows: [{ type: 'cell', tags: [] }, { type: 'gap' }] })).toEqual([])
  })

  it('names the field of a block inside a block, in a nullable list and in an optional one', () => {
    const nested = t.Object({ columns: blocks({ column: t.Object({ cells: blocks({ cell: t.Object({ text: t.String({ minLength: 1 }) }) }) }) }), maybe: t.Union([sections, t.Null()]), optional: t.Optional(sections) })
    const column = { type: 'column', cells: [{ type: 'cell', text: 'a' }, { type: 'cell', text: '' }] }

    expect(dataIssues(nested, { columns: [column], maybe: [{ type: 'hero', heading: '' }], optional: [{ type: 'hero', heading: '' }] }).map(issue => issue.path)).toEqual(['columns.0.cells.1.text', 'maybe.0.heading', 'optional.0.heading'])
    expect(dataIssues(nested, { columns: [], maybe: null }).map(issue => issue.path)).toEqual([])
  })

  it('fills the defaults of a nullable blocks list', () => {
    const maybe = t.Object({ maybe: t.Union([blocks({ a: t.Object({ n: t.Number({ default: 1 }) }) }), t.Null()]) })

    expect(withDefaults({ maybe: [{ type: 'a' }] }, maybe)).toEqual({ maybe: [{ type: 'a', n: 1 }] })
    expect(dataIssues(maybe, { maybe: [{ type: 'a' }] })).toEqual([])
    expect(withDefaults({ maybe: null }, maybe)).toEqual({ maybe: null })
  })

  it('words a refused field with the label of its own block when two share a field name', () => {
    const shared = t.Object({ sections: blocks({ hero: t.Object({ heading: t.String({ title: 'Heading H' }) }), text: t.Object({ heading: t.String({ title: 'Text title' }) }) }) })

    expect(dataIssues(shared, { sections: [{ type: 'text', heading: 5 }, { type: 'hero', heading: 5 }] }).map(issue => issue.message)).toEqual(['Text title is not valid', 'Heading H is not valid'])
  })

  it('leaves a hand-written discriminated union reported as the one value it is', () => {
    const union = t.Object({ shape: t.Union([t.Object({ type: t.Literal('a'), x: t.String() }), t.Object({ type: t.Literal('b') })]) })

    expect(dataIssues(union, { shape: { type: 'a' } }).map(issue => issue.path)).toEqual(['shape'])
  })

  it('keeps a lone type a block list too', () => {
    expect(TypeCompiler.Compile(blocks({ text: t.Object({ body: t.String() }) })).Check([{ type: 'text', body: 'x' }])).toBe(true)
  })

  it('refuses a block declaring its own type, an empty list and a name or schema it cannot store', () => {
    expect(() => blocks({ hero: t.Object({ type: t.String() }) })).toThrow('hero block declares a `type` field')
    expect(() => blocks({})).toThrow('declares no block type')
    expect(() => blocks({ '': t.Object({}) })).toThrow('empty string')
    expect(() => blocks({ hero: t.String() as never })).toThrow('not an object schema')
  })

  it('types the read as the union discriminated on type', async () => {
    type Data = Static<typeof page>

    const data: Data = { title: 'Home', sections: [{ type: 'hero', heading: 'Hi' }, { type: 'text', body: 'x' }] }
    const heading = (section: Data['sections'][number]) => {
      if (section.type === 'hero')
        return section.heading

      return section.type === 'text' ? section.body : section.images.join()
    }

    // @ts-expect-error a hero carries no body
    const wrong: Data = { title: 'x', sections: [{ type: 'hero', heading: 'x', body: 'y' }] }
    const content = collection({ name: 'blocks-typed', load: () => [{ slug: 'home', data }] }, { schema: page })

    const home = (await content.get('home'))!

    expect(home.data.sections.map(heading)).toEqual(['Hi', 'x'])
    expect(wrong).toBeDefined()
  })
})
