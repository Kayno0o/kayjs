import { join } from 'node:path'
import process from 'node:process'
import { outbox } from '@kaynooo/kayjs-mail'
import { beforeEach, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { signUp } from '../src/routes/index.kay'

// The fixture is an app installing the library, linked back to this repository by scripts/link-fixture.ts.
const ROOT = join(import.meta.dir, '..')
// kay check prints this line on success since kay 1.18, nothing before.
const CLEAN = /^(?:checked with no problems in \d+ ms\n)?$/
const site = await testSite({ root: ROOT })

beforeEach(() => outbox.clear())

test('kay check passes on the fixture, the library\'s components its mails render included', async () => {
  const check = Bun.spawn([process.execPath, join(ROOT, '..', '..', 'node_modules', '.bin', 'kay'), 'check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })

  expect(await new Response(check.stdout).text() + await new Response(check.stderr).text()).toMatch(CLEAN)
  expect(await check.exited).toBe(0)
}, 60_000)

test('an action enqueues a mail, which the queue sends to the outbox once run', async () => {
  const page = await site.submit(signUp, { name: 'Ada', email: 'ada@example.com' }, { from: '/' })

  expect(page.status).toBe(200)
  expect(outbox.mails).toEqual([])
  expect(await site.runJobs()).toBe(1)

  const sent = outbox.to('ada@example.com')

  expect(sent.map(mail => mail.subject)).toEqual(['Welcome, Ada'])
  expect(sent[0]!.text).toContain('Confirm my address (https://fixture.test/confirm?token=abc)')
  expect(sent[0]!.html).toContain('background:#0047ff')
})
