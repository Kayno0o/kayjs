import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { testSite } from 'kay/test'

// The fixture is an app installing the library, linked back to this repository by scripts/link-fixture.ts.
const ROOT = join(import.meta.dir, '..')

test('kay check passes on the fixture, the library\'s components it renders and this test included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toBe('')
  expect(await check.exited).toBe(0)
}, 60_000)

test('the fixture renders', async () => {
  const site = await testSite({ root: ROOT })

  expect((await site.visit('/')).html).toContain('<h1>kayjs-ui</h1>')
})
