import type { TestSite } from 'kay/test'
import type { LiveRequest } from '../../../../../src/runtime/live-value'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { testSite } from 'kay/test'
import { Feed, JSON_POST, pagesOf, proofsOf } from '../../../../../tests/live-helpers'

const ROOT = join(import.meta.dir, '..')
const PRESENCE = 'kay:presence'
const feeds: Feed[] = []

afterAll(async () => {
  await Promise.all(feeds.map(feed => feed.close()))
})

// What a tab of this page receives over its live connection: the members of every presence room its page proves, as the first message of each.
async function receives(site: TestSite, path: string, tab: string): Promise<{ keys: string[], messages: string[] }> {
  const { html } = await site.visit(path)
  const pages = pagesOf(html)
  const keys = pages.flatMap(page => page.values.filter(([id]) => id === PRESENCE).map(([, key]) => key))
  const feed = new Feed(await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs: proofsOf(pages), watch: keys.map(key => [PRESENCE, key]), tab } satisfies LiveRequest) }))
  const messages: string[] = []

  feeds.push(feed)

  while (messages.length < keys.length)
    messages.push(...(await feed.next()).map(update => JSON.stringify(update)))

  return { keys, messages }
}

test('an edit link\'s holder receives the editors only as a count, while a signed-in editor on the screen still receives their names', async () => {
  const screen = await testSite({ root: ROOT })
  const ann = await receives(screen, '/admin/collections/posts/notes/garden?as=Ann', 'ann-screen')

  expect(ann.keys.some(key => key.includes('"Ann"'))).toBe(true)

  // The page editor's cookie is all an edit link gives, and its page proves the rooms the screens' editors are not named in.
  const holder = await testSite({ root: ROOT })

  await holder.visit('/admin/page?path=/blog/hello')

  const page = await receives(holder, '/blog/hello', 'holder-page')

  expect(page.keys.length).toBeGreaterThan(0)
  expect(page.keys.every(key => key.includes('open:'))).toBe(true)

  // Ann edits the entry the holder's page shows, from the screens.
  const hello = await receives(screen, '/admin/collections/posts/hello?as=Ann', 'ann-hello')
  const second = await receives(holder, '/blog/hello', 'holder-page-again')

  expect(hello.keys.some(key => key.includes('"Ann"'))).toBe(true)
  expect(second.messages.join('')).not.toContain('Ann')
  expect(second.messages.some(message => message.includes('page'))).toBe(true)

  // A signed-in editor on the screen is told Ann's name.
  const bob = await receives(screen, '/admin/collections/posts/hello?as=Bob', 'bob-hello')

  expect(bob.messages.join('')).toContain('Ann')
  // And the holder is counted by the screen, with no name to give.
  expect(bob.messages.join('')).toContain('page')
}, 30_000)
