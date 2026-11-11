import { SQL } from 'bun'
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { s } from 'kay'
import { collection } from 'kay/content'
import { registerCollections } from '../../../src/content/edit'
import { pgLoader } from '../src/loaders/pg'
import { configure } from '../src/settings'
import { revokeShares, sharesRevokedAt } from '../src/share-revoke'

// The revocation kept in the `shares` sibling of a pgLoader, skipped without TEST_DATABASE_URL.
const url = process.env.TEST_DATABASE_URL ?? ''
const skip = url === ''
const admin = skip ? undefined : new SQL(Object.assign(new URL(url), { pathname: '/postgres' }).href)
const database = `kay_cms_shares_${process.pid}`
const postgresTest = test.skipIf(skip)
let shared: SQL | undefined
let restore: ReturnType<typeof registerCollections> | undefined

if (admin !== undefined) {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${database}`)
}

// A new loader over the same table, as a restarted server makes.
function notes(): void {
  shared ??= new SQL(Object.assign(new URL(url), { pathname: `/${database}` }).href, { max: 4 })
  restore = registerCollections([['notes', collection(pgLoader({ name: 'notes', source: shared, table: 'notes_shares' }), { schema: s.Object({ title: s.String() }) })]])
}

beforeEach(() => {
  configure({})
})

afterEach(() => {
  if (restore !== undefined)
    registerCollections(restore)
})

afterAll(async () => {
  await shared?.close()
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
  await admin?.close()
})

postgresTest('a revocation is read back through a fresh store, for its entry and locale alone', async () => {
  const issued = Date.now()

  notes()
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'first' })).toBeUndefined()
  await revokeShares({ collection: 'notes', slug: 'first' })
  registerCollections(restore!)
  notes()

  const at = await sharesRevokedAt({ collection: 'notes', slug: 'first' })

  expect(at).toBeGreaterThan(issued)
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'second' })).toBeUndefined()
  expect(await sharesRevokedAt({ collection: 'notes', slug: 'first', locale: 'fr' })).toBeUndefined()
})
