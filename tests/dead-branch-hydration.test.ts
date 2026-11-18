import type { TestPage, TestSite } from '../src/test'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const path = browserPath()
let root: string
let site: TestSite
let page: TestPage

const COMPONENT = `---
import { signal } from 'kay'
import Table from '@kayjs/ui/table.kay'
const COLUMNS = [{ key: 'name', header: 'Name' }]
const rows = signal([{ id: 1, name: 'Ada' }])
---
button.add(onClick={() => rows.set(list => [...list, { id: list.length + 1, name: 'Bob' }])}) Add
Table(columns={COLUMNS} rows={rows()} rowKey="id" sortable={false} label="People")
p.count {rows().length} rows
`

// A Table no call site gives a feature leaves its feature blocks as `if false`: the server wrote their markers, the island's code has no block for them, and what follows must still be claimed and update.
describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('an island whose unused feature blocks are folded away', () => {
  beforeAll(async () => {
    root = resolve(await fixtureCopy('ui-list'))
    // The variants are read from every file of the project, so the only Table is this one, and the config is Tailwind alone.
    await Promise.all(['src/components/item-list.kay', 'src/components/item-tabs.kay', 'src/components/settings-form.kay', 'src/components/status-card.kay', 'src/routes/settings.kay'].map(async file => rm(join(root, file), { force: true })))
    await Bun.write(join(root, 'kay.config.ts'), 'import tailwind from \'bun-plugin-tailwind\'\nimport { defineConfig } from \'kay/server\'\n\nexport default defineConfig({ plugins: [tailwind] })\n')
    await Bun.write(join(root, 'src/components/people.kay'), COMPONENT)
    await Bun.write(join(root, 'src/routes/index.kay'), '---\nimport People from \'../components/people.kay\'\n---\nPeople\n')
    site = await testSite({ root, browser: { path } })
    page = await site.open('/')
  }, 180_000)

  afterAll(async () => {
    page?.close()
    await site?.close()
    await rm(root, { recursive: true, force: true })
  })

  it('claims the markup the server drew, and the sibling after the kept markers updates on a click', async () => {
    expect(await page.text('p.count')).toBe('1 rows')
    expect(await page.count('tbody tr')).toBe(1)

    await page.click('button.add')
    await page.waitFor('p.count', { text: '2 rows' })

    expect(await page.count('tbody tr')).toBe(2)
    expect(await page.text('tbody tr:last-child td')).toContain('Bob')
    expect(page.errors).toEqual([])
  })
})
