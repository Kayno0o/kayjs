import type { CollectionInfo, EntryRef } from './kay/contract'
import { files } from 'kay/server'
import { wording } from 'kay/words'
import { hiddenOf } from './hidden'
import { collections, entries } from './kay/content'
import { log } from './log'
import { forgetUploads, MEDIA_FOLDER, mediaIndex, movedKeys } from './media'
import { uploadFolder } from './uploads'

export interface UnusedUpload {
  key: string
  // Where the site serves it, which the screen shows it from.
  url: string
  // The files the image route made of it, deleted with it.
  variants: string[]
}

// Either the uploads no entry references, or why they cannot be told: an unreadable collection or entry may reference any of them.
export type UploadScan = { unused: UnusedUpload[] } | { blocked: string[] }

// An upload younger than this is never listed: an entry saved to a forge the site has not rebuilt from, an open form, or another replica's save may reference it before this server reads it.
const GRACE = 24 * 60 * 60 * 1000
// A collection named so has no folder `files.list` takes.
const PRIVATE_FOLDER = /^private$/i

// The 20 hex digits of a key's random id, which a reference to the file holds whatever the URL around it: `/_kay/files/`, the site's base, an origin or a CDN.
const KEY_ID = /([\da-f]{20})(?:\.\d+x\d+(?:-[\da-f]{6})?)?\.[a-z\d]{1,10}$/
// Every window of 20 hex digits, so an id inside a longer run of them is found too.
const IDS = /(?=([\da-f]{20}))/g

interface Stored {
  key: string
  modified?: Date | undefined
}

export interface Read {
  stored: Stored[]
  // The entries mentioning each upload's id.
  usedBy: Map<string, Map<string, EntryRef>>
  // The ids that only a revision or a trashed entry mentions, which restoring brings back to an entry.
  // The uploads revisions and trash mention; undefined when they could not be read, so nothing is known deletable.
  held: Set<string> | undefined
}

export const idOf = (key: string) => KEY_ID.exec(key)?.[1]

// Every upload of the CMS's folders and the entries of any collection, locale or draft that mention each, or why they cannot be told.
// Every upload of the CMS's folders, or why they cannot be listed, with the collections they sit under.
export async function listUploads(): Promise<{ stored: Stored[], listed: CollectionInfo[] } | { blocked: string[] }> {
  // Only the names: a loaded collection's loader runs once, in `entries`, and not again to count its entries.
  const listed = await collections({ counts: false })
  const folders = [...new Set([MEDIA_FOLDER, ...listed.map(collection => uploadFolder(collection.name))])].filter(folder => !PRIVATE_FOLDER.test(folder))
  const stored: Stored[] = []

  try {
    for (const folder of folders)
      stored.push(...await files.list({ folder }))
  }
  catch (error) {
    log.error('listing the uploads failed', error)

    return { blocked: [wording('cms.uploads.listFailure', 'The files cannot be listed: {reason}', { reason: error instanceof Error ? error.message : String(error) })] }
  }

  return { stored, listed }
}

function idsIn(data: unknown, body: string | undefined): Set<string> {
  const found = new Set<string>()

  for (const text of [JSON.stringify(data, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value) ?? '', body ?? '']) {
    for (const match of text.toLowerCase().matchAll(IDS))
      found.add(match[1]!)
  }

  return found
}

// Every upload of the CMS's folders and the entries of any collection, locale or draft that mention each, or why they cannot be told.
// `history` reads the revisions and the trash too: `'block'` fails on one that cannot be read, `'soft'` leaves `held` undefined.
export async function readUploads(listing?: { stored: Stored[], listed: CollectionInfo[] }, history?: 'block' | 'soft'): Promise<Read | { blocked: string[] }> {
  const blocked: string[] = []
  const found = listing ?? await listUploads()

  if ('blocked' in found)
    return found

  const { stored, listed } = found

  const usedBy = new Map<string, Map<string, EntryRef>>()
  let held: Set<string> | undefined = new Set<string>()

  for (const collection of listed) {
    try {
      for (const entry of await entries(collection.name)) {
        if (entry.data === undefined) {
          blocked.push(wording('cms.uploads.entryParse', '{entry} does not parse', { entry: `${collection.name}/${entry.slug}` }))

          continue
        }

        for (const id of idsIn(entry.data, entry.body)) {
          const users = usedBy.get(id) ?? new Map<string, EntryRef>()

          users.set(`${collection.name}/${entry.slug}/${entry.locale ?? ''}`, { collection: collection.name, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale } })
          usedBy.set(id, users)
        }
      }
    }
    catch (error) {
      log.error(`reading ${collection.name} failed`, error)
      blocked.push(wording('cms.uploads.collectionRead', '{collection} cannot be read', { collection: collection.name }))
    }

    // A revision or a trashed entry restored points at the upload again, so it keeps the file.
    for (const kind of history === undefined ? [] : ['history', 'trash'] as const) {
      try {
        for (const row of await hiddenOf(collection.name, kind)?.load({ preview: true }) ?? []) {
          for (const id of idsIn(row.data, row.body))
            held?.add(id)
        }
      }
      catch (error) {
        log.error(`reading ${collection.name}'s ${kind} failed`, error)

        if (history === 'soft') {
          held = undefined

          continue
        }

        blocked.push(wording('cms.uploads.collectionRead', '{collection} cannot be read', { collection: collection.name }))
      }
    }
  }

  return blocked.length > 0 ? { blocked } : { stored, usedBy, held }
}

// The uploads of the CMS's folders, the shared one and each collection's older one, that no entry of any collection, locale or draft mentions.
// An upload modified less than a day ago, or that the store dates not at all, is held back, and so is one a revision or a trashed entry of a loaded collection still mentions.
// A URL hardcoded in a page or a file of the repository outside the collections is not seen: the editor confirms before anything goes.
export async function unusedUploads(): Promise<UploadScan> {
  const read = await readUploads(undefined, 'block')

  if ('blocked' in read)
    return read

  const now = Date.now()
  const orphans = read.stored.filter((file) => {
    const id = idOf(file.key)

    return id !== undefined && !read.usedBy.has(id) && !read.held!.has(id) && file.modified !== undefined && now - file.modified.getTime() >= GRACE
  }).map(file => file.key).toSorted()
  const variants = await files.variants(orphans)
  const unused = orphans.map(key => ({ key, url: files.url(key), variants: variants.get(key) ?? [] }))

  return { unused }
}

// An upload as the library shows it.
export interface LibraryUpload {
  key: string
  url: string
  name: string
  size: number | undefined
  width: number | undefined
  height: number | undefined
  by: string | undefined
  // When it was last written, in ms, when the store knows.
  at: number | undefined
  // The entries mentioning it.
  usedIn: EntryRef[]
  // Whether the unused-uploads rules let it be deleted: no entry, revision or trashed entry mentions it and it is over a day old.
  deletable: boolean
}

const DIMENSIONS = /\.(\d+)x(\d+)(?:-[\da-f]{6})?\.[a-z\d]{1,10}$/

// How many uploads a page of the library holds.
export const LIBRARY_PAGE = 48

// The size of a stored file, which an upload sent before the library has no record of; undefined when the store cannot say.
async function storedSize(key: string): Promise<number | undefined> {
  try {
    const stored = await files.get(key)
    const size = stored?.size

    if (size !== undefined && Number.isFinite(size) && size > 0)
      return size

    return stored === undefined ? undefined : (await stored.arrayBuffer()).byteLength
  }
  catch (error) {
    log.warn(`the size of ${key} could not be read`, error)

    return undefined
  }
}

export interface Library {
  uploads: LibraryUpload[]
  // The page shown, from 1, and how many there are; `total` counts the uploads the search keeps.
  page: number
  pages: number
  total: number
}

// A page of the uploads, the newest first, with the entries using each and what the index knows of it, or why they cannot be told. `q` keeps the uploads whose name or key holds it; an older upload that a copy in the shared folder replaced is left out.
export async function libraryUploads(options: { page?: number | undefined, q?: string | undefined } = {}): Promise<Library | { blocked: string[] }> {
  const read = await readUploads(undefined, 'soft')

  if ('blocked' in read)
    return read

  const index = await mediaIndex()
  const moved = movedKeys(index)
  const needle = (options.q ?? '').trim().toLowerCase()
  const named = (key: string) => index[key]?.name ?? key.split('/').at(-1)!
  const found = read.stored
    .filter(file => idOf(file.key) !== undefined && !moved.has(file.key) && (needle === '' || named(file.key).toLowerCase().includes(needle) || file.key.toLowerCase().includes(needle)))
    .toSorted((a, b) => (index[b.key]?.at ?? b.modified?.getTime() ?? 0) - (index[a.key]?.at ?? a.modified?.getTime() ?? 0))
  const pages = Math.max(1, Math.ceil(found.length / LIBRARY_PAGE))
  const page = Math.min(pages, Math.max(1, Number.isInteger(options.page) ? options.page! : 1))
  const now = Date.now()
  const uploads = await Promise.all(found.slice((page - 1) * LIBRARY_PAGE, page * LIBRARY_PAGE).map(async (file): Promise<LibraryUpload> => {
    const usedIn = [...read.usedBy.get(idOf(file.key)!)?.values() ?? []]
    const record = index[file.key]
    const [, width, height] = DIMENSIONS.exec(file.key) ?? []

    return {
      key: file.key,
      url: files.url(file.key),
      name: named(file.key),
      size: record?.size ?? await storedSize(file.key),
      width: width === undefined ? undefined : Number(width),
      height: height === undefined ? undefined : Number(height),
      by: record?.by,
      at: record?.at ?? file.modified?.getTime(),
      usedIn,
      deletable: usedIn.length === 0 && read.held !== undefined && !read.held.has(idOf(file.key)!) && file.modified !== undefined && now - file.modified.getTime() >= GRACE,
    }
  }))

  return { uploads, page, pages, total: found.length }
}

// Deletes the uploads asked for that are still unused, with their variants; `kept` holds those that a rescan found referenced, or that are no unused upload of the CMS's folders.
export async function deleteUnusedUploads(keys: string[]): Promise<{ deleted: string[], kept: string[] } | { blocked: string[] }> {
  const scan = await unusedUploads()

  if ('blocked' in scan)
    return scan

  const unused = new Set(scan.unused.map(upload => upload.key))
  const deleted: string[] = []
  const kept: string[] = []

  for (const key of new Set(keys)) {
    if (!unused.has(key)) {
      kept.push(key)

      continue
    }

    await files.delete(key)
    deleted.push(key)
  }

  if (deleted.length > 0) {
    try {
      await forgetUploads(deleted)
    }
    catch (error) {
      // The files are gone; a record left behind is harmless, as the library lists the files that exist.
      log.error('dropping the deleted uploads from the media index failed', error)
    }
  }

  return { deleted, kept }
}
