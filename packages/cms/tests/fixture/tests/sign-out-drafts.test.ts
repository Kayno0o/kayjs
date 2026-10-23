import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { cms } from '../../../src/extension'
import { passwordGuard } from '../../../src/password'

const ROOT = join(import.meta.dir, '..')
const options = { guard: passwordGuard({ editor: 'pw-editor' }) }
const built = await testSite({ root: ROOT, extensions: [cms(options)], browser: true })

cms(options)

afterAll(async () => {
  await built.close()
})

test('signing out forgets the drafts the browser kept, and a draft is kept under the person signed in', async () => {
  await using page = await built.open('/admin/sign-in')

  await page.click('input[type=password]')
  await page.type('pw-editor')
  await page.press('Enter')
  await page.waitUntil(() => document.querySelector('.kcms-admin-who') !== null, { timeout: '15s' })

  // The admin names the person it let in, which the editor keys its drafts by.
  expect(await page.evaluate(() => (/(?:^|; )kcms_editor=[0-9a-f]{16}/).test(document.cookie))).toBe(true)
  await page.evaluate(() => {
    localStorage.setItem('kcms:draft:somebody:posts:hello', '{}')
  })
  await page.click('.kcms-admin-who button')
  await page.waitUntil(() => localStorage.length === 0, { timeout: '15s' })
  expect(await page.evaluate(() => document.cookie.includes('kcms_editor'))).toBe(false)
}, 60_000)
