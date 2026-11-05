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

// `keep` of before 1.87 is `history`: a Chat still passing it fails the check instead of silently keeping 20 messages.
test('Chat refuses the removed keep prop at kay check', async () => {
  const fixture = await fixtureCopy()
  const source = await Bun.file(join(fixture, 'src/components/drafting.kay')).text()

  await Bun.write(join(fixture, 'src/components/drafting.kay'), source.replace('label="Assistant")', 'label="Assistant" keep={5})'))

  const run = Bun.spawn([process.execPath, CLI, 'check'], { cwd: fixture, env: appEnv(fixture), stdout: 'pipe', stderr: 'pipe' })
  const output = (await new Response(run.stdout).text()) + (await new Response(run.stderr).text())

  expect(await run.exited).not.toBe(0)
  expect(output).toContain('keep')
}, 120_000)
