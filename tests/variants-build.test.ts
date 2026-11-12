import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { fixtureCopy } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

describe('a component with features', () => {
  it('ships the ones its call sites write: a Table with a filter and pages carries neither the CSV export nor the row selection', async () => {
    const root = resolve(await fixtureCopy('ui-list'))

    dirs.push(root)
    const client = await buildClient(root)
    const chunks = client.islands['src/components/item-list.kay']!
    const text = (await Promise.all(chunks.map(async chunk => Bun.file(join(client.dir, chunk.slice('/_kay/'.length))).text()))).join('\n')

    // The page size picker and the filter are in.
    expect(text).toContain('ui.table.filter')
    expect(text).toContain('pageSizes')
    // Export and selection are not: their modules and the code behind them stay out.
    expect(text).not.toContain('text/csv')
    expect(text).not.toContain('ui.table.selectRow')
  }, 120_000)
})
