import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { usesNames } from '../src/build/variants'
import { fixtureCopy } from './scratch'
import { pages } from './shared-pages'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

const PAGE = (table: string) => `---\nimport Table from '@kaynooo/kayjs-ui/table.kay'\n\nconst COLUMNS = [{ key: 'name', header: 'Name' }]\nconst ROWS = [{ id: 1, name: 'Ada' }]\n---\n${table}\n`

describe('a Table drawn by a page', () => {
  it('is no island with nothing interactive, sorting or not, and one with any feature', async () => {
    const root = resolve(await fixtureCopy('ui-list'))

    dirs.push(root)
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'static-table', dependencies: { 'kay': '*', '@kaynooo/kayjs-ui': '*' }, devDependencies: { '@iconify-json/tabler': '*' } }))

    const tables = { plain: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id" sortable={false} label="People")', sorted: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id")', selected: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id" sortable={false} selectable)', paged: 'Table(columns={COLUMNS} rows={ROWS} rowKey="id" sortable={false} pageSize={5})' }

    await Promise.all(Object.entries(tables).map(async ([name, table]) => Bun.write(join(root, `src/routes/static-${name}.kay`), PAGE(table))))

    const app = new Elysia().use(await pages({ root, prebuilt: false, security: false }))
    const page = async (name: string) => (await app.handle(new Request(`http://localhost/static-${name}`))).text()
    const slots = (html: string) => html.match(/<slot data-component="[^"]*table\.kay"/g)?.length ?? 0
    const plain = await page('plain')

    expect(plain).toContain('Ada')
    expect(slots(plain)).toBe(0)
    expect(slots(await page('sorted'))).toBe(0)

    // The scroll box is a keyboard stop that screen readers name, as the browser would make it of a table that scrolls.
    expect(plain).toMatch(/<div[^>]*tabindex="0"[^>]*>/)
    expect(plain).toMatch(/<div[^>]*role="region"[^>]*aria-label="People"|<div[^>]*aria-label="People"[^>]*role="region"/)

    for (const name of ['selected', 'paged'])
      expect(slots(await page(name)), name).toBe(1)
  }, 120_000)
})

describe('the Table', () => {
  it('lists every feature it declares with `uses` among the props that make it interactive, but `sortParam`', async () => {
    const file = resolve('packages/ui/src/table.kay')
    const source = await Bun.file(file).text()
    const listed = Object.keys(JSON.parse(source.match(/interactive: (\{[^}]*\})/)![1]!.replace(/(\w+):/g, '"$1":')) as Record<string, boolean>)

    // Sorting is script-free in a plain Table, its headers links that keep the sort in the URL under `sortParam`.
    expect(listed).not.toContain('sortable')
    expect(listed).not.toContain('sortParam')

    for (const name of await usesNames(source, file))
      expect(name === 'sortParam' || listed.includes(name), name).toBe(true)
  })
})
