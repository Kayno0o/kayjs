import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { appEnv, fixtureCopy } from './helpers/fixtureCopy'

const CLI = join(import.meta.dir, '../../../src/cli.ts')

// The fixture holds a Chat over a reply action that can also `ctx.fail`, which Chat's `action` must accept.
test('Chat takes a reply action that can also ctx.fail, and kay check passes the fixture', async () => {
  const fixture = await fixtureCopy()
  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: fixture, env: appEnv(fixture), stdout: 'ignore', stderr: 'ignore' })

  expect(await run.exited).toBe(0)
}, 120_000)
