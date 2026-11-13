import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const HEAD = '---\nimport Table from \'@kayjs/ui/table.kay\'\n\nconst COLUMNS = [{ key: \'name\', header: \'Name\', sortValue: true }, { key: \'age\', header: \'Age\', numeric: true }]\nconst ROWS = [{ id: 1, name: \'Cleo\', age: 40 }, { id: 2, name: \'Ada\', age: 36 }, { id: 3, name: \'Bo\', age: 52 }]\n---\n'
const SLOT = /<slot data-component="[^"]*table\.kay"/g
const HEADERS = /<th[^>]*>.*?<\/th>/gs

describe('a Table drawn by a page that sorts', () => {
  let root = ''
  let app: Elysia
  let mounted: Elysia

  const get = async (server: Elysia, path: string) => (await server.handle(new Request(`http://localhost${path}`))).text()
  // The rows' names in the order first drawn.
  const names = (html: string) => [...new Set([...html.matchAll(/Cleo|Ada|Bo(?![a-z])/g)].map(([name]) => name))]
  const hrefs = (html: string) => [...html.matchAll(/<a[^>]*data-part="sortButton"[^>]*>/g)].map(([tag]) => (/href="([^"]*)"/).exec(tag)![1]!.replaceAll('&amp;', '&'))

  beforeAll(async () => {
    root = resolve(await fixtureCopy('ui-list'))
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'static-sort', dependencies: { 'kay': '*', '@kayjs/ui': '*' }, devDependencies: { '@iconify-json/tabler': '*' } }))

    const tables = {
      one: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id")',
      two: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id")\nTable(columns={COLUMNS} rows={ROWS} rowKey="id" sortParam="people")',
      off: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id" sortable={false})',
      selectable: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id" selectable)',
      named: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id" selectable sortParam="people")',
    }

    await Promise.all(Object.entries(tables).map(async ([name, table]) => Bun.write(join(root, `src/routes/sort-${name}.kay`), `${HEAD}${table}\n`)))
    app = new Elysia().use(await pages({ root, prebuilt: false, security: false }))
    mounted = new Elysia().use(await pages({ root, prebuilt: false, security: false, base: '/repo', trailingSlash: 'always' }))
  }, 120_000)

  afterAll(async () => rm(root, { recursive: true, force: true }))

  it('is no island, its sortable headers links that sort by the column in its default direction', async () => {
    const html = await get(app, '/sort-one')

    expect(html.match(SLOT)).toBeNull()
    expect(html).not.toContain('<button')
    expect(hrefs(html)).toEqual(['/sort-one?sort=name&direction=desc', '/sort-one?sort=age&direction=desc'])
    expect(html).not.toContain('aria-sort')
  }, 60_000)

  it('sorts the rows by the URL and sets aria-sort on the sorted header, its link flipping the direction', async () => {
    const asc = await get(app, '/sort-one?sort=name&direction=asc&keep=1')

    expect(names(asc)).toEqual(['Ada', 'Bo', 'Cleo'])
    expect(asc.match(HEADERS)![0]).toContain('aria-sort="ascending"')
    expect(hrefs(asc)[0]).toBe('/sort-one?sort=name&direction=desc&keep=1')

    const desc = await get(app, '/sort-one?sort=age&direction=desc')

    expect(names(desc)).toEqual(['Bo', 'Cleo', 'Ada'])
    expect(desc.match(HEADERS)![1]).toContain('aria-sort="descending"')
    expect(names(await get(app, '/sort-one?sort=nope&direction=asc'))).toEqual(['Cleo', 'Ada', 'Bo'])
  }, 60_000)

  it('keeps one sort per table, `sortParam` naming the second one', async () => {
    const html = await get(app, '/sort-two?people=name&peopleDirection=asc')
    const [first, second] = html.split('<table').slice(1)

    expect(names(first!)).toEqual(['Cleo', 'Ada', 'Bo'])
    expect(names(second!)).toEqual(['Ada', 'Bo', 'Cleo'])
    expect(html.match(SLOT)).toBeNull()
    expect(hrefs(html).slice(0, 2)).toEqual(['/sort-two?people=name&peopleDirection=asc&sort=name&direction=desc', '/sort-two?people=name&peopleDirection=asc&sort=age&direction=desc'])
    expect(hrefs(html)[2]).toBe('/sort-two?people=name&peopleDirection=desc')
    expect(hrefs(html)[3]).toBe('/sort-two?people=age&peopleDirection=desc')
  }, 60_000)

  it('keeps the base and the trailing slash of the page', async () => {
    const html = await get(mounted, '/sort-one/?sort=age&direction=asc')

    expect(hrefs(html)).toEqual(['/repo/sort-one/?sort=name&direction=desc', '/repo/sort-one/?sort=age&direction=desc'])
    expect(names(html)).toEqual(['Ada', 'Cleo', 'Bo'])
  }, 60_000)

  it('draws no sort control with `sortable={false}`, and stays an island with a feature, its headers buttons', async () => {
    const off = await get(app, '/sort-off?sort=name&direction=asc')

    expect(off.match(SLOT)).toBeNull()
    expect(off).not.toContain('data-part="sortButton"')
    expect(names(off)).toEqual(['Cleo', 'Ada', 'Bo'])

    const island = await get(app, '/sort-selectable')

    expect(island.match(SLOT)?.length).toBe(1)
    expect(island).toContain('<button')
    expect(hrefs(island)).toEqual([])
  }, 60_000)

  it('reads the sort of a Table that is an island from its `sortParam` too', async () => {
    const html = await get(app, '/sort-named?people=name&peopleDirection=asc')

    expect(html.match(SLOT)?.length).toBe(1)
    expect(names(html.slice(html.indexOf('<tbody')))).toEqual(['Ada', 'Bo', 'Cleo'])
    expect(hrefs(html)).toEqual([])
  }, 60_000)
})
