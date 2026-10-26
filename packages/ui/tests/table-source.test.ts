import { cp, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { scratchDir } from '../../../tests/scratch'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')

// One scratch copy of the fixture holds a Table per case, checked in one `kay check` run, so the shared fixture never meets a type error.
const CASES = [
  { name: 'rows', props: 'rows={[{ id: 1 }]}' },
  { name: 'list', props: 'list={feed}' },
  { name: 'neither', props: '' },
  { name: 'both', props: 'rows={[{ id: 1 }]} list={feed}' },
]

test('a Table takes rows or a list, and fails kay check with neither or both', async () => {
  const dir = await scratchDir('table-source-')

  await cp(FIXTURE, dir, { recursive: true, filter: source => !(/\/(?:\.kay|node_modules)$/).test(source) })
  await symlink(join(FIXTURE, 'node_modules'), join(dir, 'node_modules'))

  for (const item of CASES) {
    await Bun.write(join(dir, `src/components/source-${item.name}.kay`), `---
${item.props.includes('feed') ? 'import { infiniteList } from \'@kaynooo/kayjs-ui\'\n' : ''}import Table from '@kaynooo/kayjs-ui/table.kay'

${item.props.includes('feed') ? '// kay-island\nconst feed = infiniteList([{ id: 1 }], { pageSize: 1, load: () => [] })' : ''}
---
Table(columns={[{ key: 'id', header: 'Id' }]} rowKey="id" ${item.props})
`)
  }

  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
  const errorsOf = (file: string) => (out + err).split(/(?=^error\[)/m).filter(block => block.includes(`source-${file}.kay`)).join('')

  await run.exited

  expect(errorsOf('rows')).toBe('')
  expect(errorsOf('list')).toBe('')
  expect(errorsOf('neither')).not.toBe('')
  expect(errorsOf('both')).not.toBe('')
}, 300_000)
