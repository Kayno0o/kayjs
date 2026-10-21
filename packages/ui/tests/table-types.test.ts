import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')

// The fixture's typed-bulk-table passes a Table's `keys` to `string[]` and `number[]` parameters with no cast, for a field `rowKey` and a function one.
test('a Table\'s selection keys take the rowKey\'s type, and kay check passes the fixture', async () => {
  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: FIXTURE, stdout: 'ignore', stderr: 'ignore' })

  expect(await run.exited).toBe(0)
}, 120_000)
