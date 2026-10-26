import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { appCopy } from '../../../tests/scratch'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')

// One scratch copy of the fixture holds a Table per case, checked in one `kay check` run, so the shared fixture never meets a type error.
const CASES = [
  { name: 'rows', props: 'rows={[{ id: 1 }]}', feed: false },
  { name: 'list', props: 'list={feed}', feed: true },
  { name: 'neither', props: '', feed: false },
  { name: 'both', props: 'rows={[{ id: 1 }]} list={feed}', feed: true },
]

test('a Table takes rows or a list, and fails kay check with neither or both', async () => {
  const dir = await appCopy(FIXTURE, 'table-source-')

  await symlink(join(FIXTURE, 'node_modules'), join(dir, 'node_modules'))

  for (const item of CASES) {
    await Bun.write(join(dir, `src/components/source-${item.name}.kay`), `---
${item.feed ? 'import { infiniteList } from \'@kaynooo/kayjs-ui\'\n' : ''}import Table from '@kaynooo/kayjs-ui/table.kay'

${item.feed ? '// kay-island\nconst feed = infiniteList([{ id: 1 }], { pageSize: 1, load: () => [] })' : ''}
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
  expect(errorsOf('neither')).toContain('TS2322')
  expect(errorsOf('both')).toContain('TS2322')
}, 300_000)
