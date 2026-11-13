import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { loadConfig } from '../src/config-loader'
import { clientOptionsOf } from '../src/project'
import { fixtureCopy } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

// What only the code of a feature holds: the CSV export, the row selection, the expand toggle, the virtual window, the list sync.
const EXPORT = 'text/csv'
const SELECT = 'ui.table.selectRow'
const EXPAND = 'ui.table.expandRow'
const VIRTUAL = 'overscan'
const LIST = 'restart('

// An island holding a Table written as `table`, a signal making it one.
function island(imports: string, table: string): string {
  return `---\nimport { signal } from 'kay'\nimport Table from '@kayjs/ui/table.kay'\n${imports}\nconst COLUMNS = [{ key: 'name', header: 'Name' }]\nconst rows = signal([{ id: 1, name: 'a' }])\n---\nbutton(onClick={() => rows.set([])}) Clear\n${table}\n`
}

async function built(components: Record<string, string>) {
  const root = resolve(await fixtureCopy('ui-list'))

  dirs.push(root)

  const page = Object.keys(components).map(name => `import ${name} from '../components/${name.toLowerCase()}.kay'`).join('\n')
  const uses = Object.keys(components).map(name => name).join('\n')

  await Promise.all(Object.entries(components).map(async ([name, text]) => Bun.write(join(root, `src/components/${name.toLowerCase()}.kay`), text)))
  await Bun.write(join(root, 'src/routes/variants.kay'), `---\n${page}\n---\n${uses}\n`)

  const client = await buildClient(root)
  const text = async (name: string) => (await Promise.all(client.islands[`src/components/${name.toLowerCase()}.kay`]!.map(async chunk => Bun.file(join(client.dir, chunk.slice('/_kay/'.length))).text()))).join('\n')

  return { client, text }
}

describe('a component with features', () => {
  it('ships the ones its call sites write: a Table with a filter and pages carries none of the others', async () => {
    const root = resolve(await fixtureCopy('ui-list'))

    dirs.push(root)
    const client = await buildClient(root)
    const chunks = client.islands['src/components/item-list.kay']!
    const text = (await Promise.all(chunks.map(async chunk => Bun.file(join(client.dir, chunk.slice('/_kay/'.length))).text()))).join('\n')

    expect(text).toContain('ui.table.filter')
    expect(text).toContain('pageSizes')

    for (const left of [EXPORT, SELECT, EXPAND, VIRTUAL, LIST])
      expect(text, left).not.toContain(left)
  }, 120_000)

  it('is whole where a file spreads onto it or reads it as a value, and one variant serves every island that uses it', async () => {
    const { text } = await built({
      Spread: island('', 'Table({...{ selectable: true }} columns={COLUMNS} rows={rows()} rowKey="id")'),
      Value: island('const keep = Table\nconsole.log(keep)', 'Table(columns={COLUMNS} rows={rows()} rowKey="id")'),
    })

    // A spread anywhere asks for every feature of the component, in every island.
    for (const name of ['Spread', 'Value']) {
      const code = await text(name)

      expect(code, name).toContain(EXPORT)
      expect(code, name).toContain(EXPAND)
      expect(code, name).toContain(VIRTUAL)
      expect(code, name).toContain(LIST)
    }
  }, 120_000)

  it('is the union of the call sites of the project: two islands share one Table, each with the features of both', async () => {
    const { client, text } = await built({
      Picking: island('', 'Table(columns={COLUMNS} rows={rows()} rowKey="id" selectable)'),
      Saving: island('', 'Table(columns={COLUMNS} rows={rows()} rowKey="id" exportable)'),
    })
    const picking = client.islands['src/components/picking.kay']!
    const saving = client.islands['src/components/saving.kay']!
    const bodies = new Set<string>()

    for (const name of ['Picking', 'Saving']) {
      const code = await text(name)

      expect(code, name).toContain(SELECT)
      expect(code, name).toContain(EXPORT)
      expect(code, name).not.toContain(EXPAND)
    }

    // The core of the Table is in one chunk both load.
    for (const chunk of [...picking, ...saving]) {
      if ((await Bun.file(join(client.dir, chunk.slice('/_kay/'.length))).text()).includes('ui.table.loading'))
        bodies.add(chunk)
    }

    expect(bodies.size).toBe(1)
  }, 120_000)

  it('leaves the marks, the selection and the tooltip out of a BarChart that is written without them', async () => {
    const chart = (props: string) => `---\nimport { signal } from 'kay'\nimport BarChart from '@kayjs/ui/bar-chart.kay'\nconst values = signal([1, 2])\n---\nbutton(onClick={() => values.set([])}) Clear\nBarChart(label="Runs" labels={['a', 'b']} series={[{ name: 'Runs', values: values() }]}${props})\n`
    const plain = await (await built({ Plain: chart('') })).text('Plain')
    const whole = await (await built({ Spread: chart(' {...{}}') })).text('Spread')

    // The link and button columns, the events and the tooltip are code a chart without those props never draws.
    expect(whole).toContain('data-kind')
    expect(plain).not.toContain('data-kind')
    expect(whole.length - plain.length).toBeGreaterThan(4000)
  }, 120_000)

  it('leaves the selection and the tooltip out of a ScatterChart, and the marks and the selection out of a LineChart, written without them', async () => {
    const scatter = (props: string) => `---\nimport { signal } from 'kay'\nimport ScatterChart from '@kayjs/ui/scatter-chart.kay'\nconst points = signal([{ key: 'a', x: 1, y: 2, label: 'a' }])\n---\nbutton(onClick={() => points.set([])}) Clear\nScatterChart(label="Runs" points={points()}${props})\n`
    const line = (props: string) => `---\nimport { signal } from 'kay'\nimport LineChart from '@kayjs/ui/line-chart.kay'\nconst values = signal([1, 2])\n---\nbutton(onClick={() => values.set([])}) Clear\nLineChart(label="Runs" labels={['a', 'b']} series={[{ name: 'Runs', values: values() }]}${props})\n`

    for (const [name, write, marker] of [['Scatter', scatter, 'data-kind'], ['Line', line, 'data-kind']] as const) {
      const plain = await (await built({ [name]: write('') })).text(name)
      const whole = await (await built({ [name]: write(' {...{}}') })).text(name)

      expect(whole.length - plain.length, name).toBeGreaterThan(2000)
      expect(whole, name).toContain(marker)
      expect(plain, name).not.toContain(marker)
    }
  }, 120_000)

  it('is the variant a page needs when the page draws it itself, as its own island', async () => {
    const root = resolve(await fixtureCopy('ui-list'))

    dirs.push(root)
    // The app depends on the library, which is how kay finds its components.
    await Bun.write(join(root, 'package.json'), JSON.stringify({ name: 'direct', dependencies: { 'kay': '*', '@kayjs/ui': '*' }, devDependencies: { '@iconify-json/tabler': '*' } }))
    await Bun.write(join(root, 'src/routes/direct.kay'), '---\nimport Table from \'@kayjs/ui/table.kay\'\n\nconst COLUMNS = [{ key: \'name\', header: \'Name\' }]\nconst ROWS = [{ id: 1, name: \'a\' }]\n---\nTable(columns={COLUMNS} rows={ROWS} rowKey="id" selectable)\n')

    const client = await buildClient(root, clientOptionsOf(await loadConfig(root), { dev: false, underKayDev: false }))
    const id = Object.keys(client.islands).find(name => name.endsWith('/table.kay'))!
    const text = (await Promise.all(client.islands[id]!.map(async chunk => Bun.file(join(client.dir, chunk.slice('/_kay/'.length))).text()))).join('\n')

    // The page's call site and the list's together name several features, which the entry's file name carries.
    for (const chunk of client.islands[id]!)
      expect(chunk, chunk).not.toMatch(/[?=]/)

    expect(text).toContain(SELECT)
    // No call site of the project writes these.
    expect(text).not.toContain(EXPORT)
    expect(text).not.toContain(EXPAND)
  }, 120_000)
})
