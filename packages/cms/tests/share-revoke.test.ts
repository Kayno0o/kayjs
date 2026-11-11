import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { activityOf } from '../src/activity'
import { sqliteLoader } from '../src/loaders/sqlite'
import { configure } from '../src/settings'
import { revokeShares, sharesRevokedAt } from '../src/share-revoke'

const { default: entriesApi } = await import('../src/api/entries')

let restore: ReturnType<typeof registerCollections>

beforeEach(() => {
  configure({})
  restore = registerCollections([['notes', collection(sqliteLoader({ name: 'notes', database: ':memory:', table: 'revoke_notes' }), { schema: s.Object({ title: s.String() }) })]])
})

afterEach(() => {
  registerCollections(restore)
})

test('an entry has no revocation until its links are revoked, then a time that is now, for that entry and locale alone', async () => {
  const before = Date.now()

  expect(await sharesRevokedAt({ collection: 'notes', slug: 'first' })).toBeUndefined()
  await revokeShares({ collection: 'notes', slug: 'first' })

  const at = await sharesRevokedAt({ collection: 'notes', slug: 'first' })

  expect(at).toBeGreaterThan(before)
  expect(at).toBeLessThanOrEqual(Date.now() + 1)
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'second' })).toBeUndefined()
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'first', locale: 'fr' })).toBeUndefined()
})

test('a second revocation moves the time forward', async () => {
  await revokeShares({ collection: 'notes', slug: 'first' })

  const first = await sharesRevokedAt({ collection: 'notes', slug: 'first' })

  await Bun.sleep(5)
  await revokeShares({ collection: 'notes', slug: 'first' })
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'first' })).toBeGreaterThan(first!)
})

test('the route revokes the links and logs it in the activity of the collection', async () => {
  const response = await new Elysia({ prefix: '/_kay/cms/entries' }).use(entriesApi).handle(new Request('http://site.test/_kay/cms/entries/notes/first/revoke-shares', { method: 'POST' }))

  expect(response.status).toBe(200)
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'first' })).toBeGreaterThan(0)
  expect((await activityOf('notes')).map(event => [event.verb, event.slug])).toEqual([['unshare', 'first']])
})
