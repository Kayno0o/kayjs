import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'

const CLI = join(import.meta.dir, '../../../src/cli.ts')
const FIXTURE = join(import.meta.dir, 'fixture')

// The fixture holds a Chat over a reply action that can also `ctx.fail`, which Chat's `action` must accept.
test('Chat takes a reply action that can also ctx.fail, and kay check passes the fixture', async () => {
  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: FIXTURE, stdout: 'ignore', stderr: 'ignore' })

  expect(await run.exited).toBe(0)
}, 120_000)
