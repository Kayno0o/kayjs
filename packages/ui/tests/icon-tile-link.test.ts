import { symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { appCopy } from '../../../tests/scratch'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')

const CASES = [
  { name: 'named', props: 'icon="info" href="/x" label="Sites"' },
  { name: 'decorative', props: 'icon="info"' },
  { name: 'unnamed', props: 'icon="info" href="/x"' },
]

test('an IconTile with an href needs a label, which names the link', async () => {
  const dir = await appCopy(FIXTURE, 'icon-tile-link-')

  await symlink(join(FIXTURE, 'node_modules'), join(dir, 'node_modules'))

  for (const item of CASES) {
    await Bun.write(join(dir, `src/components/tile-${item.name}.kay`), `---
import IconTile from '@kayjs/ui/icon-tile.kay'
---
IconTile(${item.props})
`)
  }

  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
  const errorsOf = (file: string) => (out + err).split(/(?=^error\[)/m).filter(block => block.includes(`tile-${file}.kay`)).join('')

  await run.exited

  expect(errorsOf('named')).toBe('')
  expect(errorsOf('decorative')).toBe('')
  expect(errorsOf('unnamed')).toContain('Property \'label\' is missing')
}, 120_000)
