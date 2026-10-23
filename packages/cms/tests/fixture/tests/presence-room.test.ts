import type { TestSite } from 'kay/test'
import type { LiveRequest } from '../../../../../src/runtime/live-value'
import { join } from 'node:path'
import { afterAll, expect, test } from 'bun:test'
import { previewUrl } from 'kay/server'
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

// What a request sent of the entry's rooms, as the names of the editors in them.
function namesIn(received: { messages: string[] }): string {
  return received.messages.join('')
}

test('an edit link\'s holder receives the editors only as a count, while a signed-in editor, on a screen or on the page, receives their names', async () => {
  const screen = await testSite({ root: ROOT })
  const ann = await receives(screen, '/admin/collections/posts/notes/garden?as=Ann', 'ann-screen')

  expect(ann.keys.some(key => key.includes('"Ann"'))).toBe(true)

  // An edit link is all this browser holds: no guard of the app let it in.
  const holder = await testSite({ root: ROOT })

  await holder.visit(previewUrl('/blog/hello', { edit: true }))

  const page = await receives(holder, '/blog/hello', 'holder-page')

  expect(page.keys.some(key => key.includes('open:'))).toBe(true)

  // Ann edits the entry the holder's page shows, from the screens.
  const hello = await receives(screen, '/admin/collections/posts/hello?as=Ann', 'ann-hello')
  const second = await receives(holder, '/blog/hello', 'holder-page-again')

  expect(hello.keys.some(key => key.includes('"Ann"'))).toBe(true)
  expect(second.keys.some(key => key.includes('"cms:posts:hello"'))).toBe(true)
  expect(namesIn(second)).not.toContain('Ann')
  // The render itself carries no name either: the page and its live proofs are what the holder reads.
  expect((await holder.visit('/blog/hello')).html).not.toContain('Ann')

  // A proof replayed with no edit cookie at all is told no names: the proof is not tied to the page's cookies.
  const { html } = await holder.visit('/blog/hello')
  const pages = pagesOf(html)
  const keys = pages.flatMap(page => page.values.filter(([id]) => id === PRESENCE).map(([, key]) => key))
  const replay = new Feed(await holder.fetch('/_kay/live', { ...JSON_POST, headers: { ...JSON_POST.headers, cookie: 'kay_preview=' }, body: JSON.stringify({ proofs: proofsOf(pages), watch: keys.map(key => [PRESENCE, key]), tab: 'replay' } satisfies LiveRequest) }))

  feeds.push(replay)

  const replayed: string[] = []

  while (replayed.length < keys.length)
    replayed.push(...(await replay.next()).map(update => JSON.stringify(update)))

  expect(replayed.join('')).not.toContain('Ann')
  // Counted all the same: the members are there, with no name.
  expect(second.messages.some(message => message.includes('"page":true') || message.includes('\\"page\\":true'))).toBe(true)

  // A person the guard let in, on a screen and on the page, is told Ann's name.
  const bob = await receives(screen, '/admin/collections/posts/hello?as=Bob', 'bob-hello')

  expect(namesIn(bob)).toContain('Ann')
  expect(namesIn(bob)).toContain('page')

  const member = await testSite({ root: ROOT })

  await member.visit('/admin/page?path=/blog/hello')

  const named = await receives(member, '/blog/hello', 'member-page')

  expect(named.keys.some(key => key.includes('"cms:posts:hello"'))).toBe(true)
  expect(namesIn(named)).toContain('Ann')
}, 30_000)

test('a person who entered edit mode through an edit link and was let in by the guard since is told the names, with no state kept by the process', async () => {
  const screen = await testSite({ root: ROOT })

  await receives(screen, '/admin/collections/posts/hello?as=Ann', 'ann-screen')

  const person = await testSite({ root: ROOT })

  await person.visit(previewUrl('/blog/hello', { edit: true }))
  expect(namesIn(await receives(person, '/blog/hello', 'before-guard'))).not.toContain('Ann')

  // The guard lets the same browser in: its edit cookie is marked by a cookie of its own, which any process can check.
  await person.visit('/admin/collections/posts/hello?as=Bob')
  expect(namesIn(await receives(person, '/blog/hello', 'after-guard'))).toContain('Ann')

  // Another holder, entering in the same second, shares nothing with that browser.
  const other = await testSite({ root: ROOT })

  await other.visit(previewUrl('/blog/hello', { edit: true }))
  expect(namesIn(await receives(other, '/blog/hello', 'other-holder'))).not.toContain('Ann')
}, 30_000)
