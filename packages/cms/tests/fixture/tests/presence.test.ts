import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { memoryRooms } from 'kay/server'
import { testSite } from 'kay/test'

const ROOT = join(import.meta.dir, '..')
const rooms = memoryRooms()
const built = await testSite({ root: ROOT, browser: true, store: { rooms } })
// A tab that closed leaves its room after a grace and a heartbeat.
const SETTLED = { timeout: '15s' } as const

async function waitUntil(done: () => boolean): Promise<void> {
  const until = Date.now() + 15_000

  while (!done()) {
    if (Date.now() > until)
      throw new Error('the previous test\'s tabs never left the entry\'s room')

    await Bun.sleep(50)
  }
}

afterAll(async () => {
  await built.close()
})

test('two lists open on the same entries do not say they are being edited', async () => {
  await using first = await built.open('/admin/collections/posts?as=Bob')
  await using second = await built.open('/admin/collections/posts?as=Cy')

  // A deliberate wait for nothing to appear: both lists have joined their rooms long before.
  await Bun.sleep(2000)
  expect(await first.evaluate(() => document.querySelectorAll('.kcms-entry-watch').length)).toBe(0)
  expect(await second.evaluate(() => document.querySelectorAll('.kcms-entry-watch').length)).toBe(0)
}, 60_000)

test('the on-page editor and the list join an entry\'s room: the screen names its editors, the page editor of a signed-in editor names them too, and a list only shows that the entry is being edited', async () => {
  const screenSays = () => document.querySelector('.kcms-entry-presence')?.textContent?.trim()
  const pageSays = () => document.querySelector('.kcms-editor .kcms-entry-presence')?.textContent?.trim()

  await using screen = await built.open('/admin/collections/posts/hello?as=Ann')
  await using onPage = await built.open('/admin/page?path=/blog/hello')

  await onPage.waitUntil(() => document.querySelector('.kcms-editor .kcms-entry-presence')?.textContent?.trim() === 'Also open: Ann', SETTLED)
  await screen.waitUntil(() => document.querySelector('.kcms-entry-presence')?.textContent?.trim() === '1 other editor', SETTLED)

  await using list = await built.open('/admin/collections/posts?as=Bob')

  await list.waitUntil(() => [...document.querySelectorAll('.kcms-entry-watch')].some(mark => mark.textContent?.trim() === 'Being edited by Ann'), SETTLED)
  // The list is no editor: neither the screen nor the page editor counts it, which a deliberate wait for nothing to change gives time to show.
  await Bun.sleep(300)
  expect(await screen.evaluate(screenSays)).toBe('1 other editor')
  expect(await onPage.evaluate(pageSays)).toBe('Also open: Ann')
}, 60_000)

test('editors with no name still count each other when a list is open, and the list says the entry is being edited', async () => {
  const says = () => document.querySelector('.kcms-editor .kcms-entry-presence')?.textContent?.trim()

  // The tabs the previous test closed are kept in the entry's room for a grace, and count as editors until then: a wait for "1 other editor" they satisfy would end when they leave, before the second editor has joined.
  await waitUntil(() => rooms.members(`kay:presence:open:cms:posts:hello`).length === 0)

  await using list = await built.open('/admin/collections/posts?as=Bob')
  await using first = await built.open('/admin/page?path=/blog/hello')
  await using second = await built.open('/admin/page?path=/blog/hello')

  await list.waitUntil(() => [...document.querySelectorAll('.kcms-entry-watch')].some(mark => mark.textContent?.trim() === 'Being edited'), SETTLED)
  await first.waitUntil(() => document.querySelector('.kcms-editor .kcms-entry-presence')?.textContent?.trim() === '1 other editor', SETTLED)
  await second.waitUntil(() => document.querySelector('.kcms-editor .kcms-entry-presence')?.textContent?.trim() === '1 other editor', SETTLED)
  expect([await first.evaluate(says), await second.evaluate(says)]).toEqual(['1 other editor', '1 other editor'])
}, 60_000)
