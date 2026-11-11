import type { ContentLoader } from 'kay/content'
import type { Identity } from './files'
import type { EntryRef } from './kay/contract'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { repositoryRoot } from 'kay/content'
import { fileVersion } from './files'
import { rowOf } from './hidden'
import { collectionLoader } from './kay/content'

import { placeOf } from './revisions'
import { settings } from './settings'

// What revokes the share links of an entry: the time before which none is accepted, kept in the hidden `shares` collection beside a loaded collection's entries, or as a file of the repository for a folder's, as a review is. Kept whether or not `cms({ history })` is on.
const siblings = new WeakMap<ContentLoader, ContentLoader>()

function storeOf(collection: string): ContentLoader | undefined {
  const loader = collectionLoader(collection)

  if (loader?.sibling === undefined)
    return undefined

  let sibling = siblings.get(loader)

  if (sibling === undefined) {
    sibling = loader.sibling('shares')
    siblings.set(loader, sibling)
  }

  return sibling
}

// A name with no separator and no dot, so no collection or slug reaches outside `.cms/shares`.
const encoded = (name: string) => encodeURIComponent(name).replaceAll('.', '%2E')
const fileOf = (ref: EntryRef) => join(repositoryRoot(), '.cms', 'shares', encoded(ref.collection), `${encoded(placeOf(ref))}.json`)

// A stored value as a time, undefined for anything else.
const timeOf = (data: unknown) => typeof data === 'object' && data !== null && typeof (data as { at?: unknown }).at === 'number' ? (data as { at: number }).at : undefined

// The time (milliseconds) before which a share link of the entry is refused, undefined when none was revoked. Throws when it cannot be read, so the link is refused rather than served.
export async function sharesRevokedAt(ref: EntryRef): Promise<number | undefined> {
  if (collectionLoader(ref.collection) === undefined) {
    const file = Bun.file(fileOf(ref))

    return await file.exists() ? timeOf(await file.json()) : undefined
  }

  const store = storeOf(ref.collection)

  return store === undefined ? undefined : timeOf((await rowOf(store, placeOf(ref)))?.data)
}

// Refuses every link made for the entry until now; throws when the time cannot be written, which the caller answers with.
export async function revokeShares(ref: EntryRef, author?: Identity | undefined): Promise<void> {
  // One past the clock, so a link made in this same millisecond is refused too.
  const data = { at: Date.now() + 1 }

  if (collectionLoader(ref.collection) === undefined) {
    const absolute = fileOf(ref)
    const file = Bun.file(absolute)

    await mkdir(join(absolute, '..'), { recursive: true })
    await settings().files.save({
      base: await file.exists() ? fileVersion(await file.bytes()) : null,
      repoPath: relative(repositoryRoot(), absolute).split('\\').join('/'),
      absolute,
      text: `${JSON.stringify(data)}\n`,
      message: `content(${ref.collection}): revoke the share links of ${ref.slug}`,
      author,
    })

    return
  }

  const store = storeOf(ref.collection)

  if (store?.save === undefined)
    throw new Error(`${ref.collection} cannot keep a revocation: its loader gives no sibling`)

  await store.save({ slug: placeOf(ref), data })
}
