import { files } from 'kay/server'
import { wording } from 'kay/words'
import { collections, entries } from './kay/content'
import { log } from './log'
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

// The uploads of the CMS's folders that no entry of any collection, locale or draft mentions.
// An upload modified less than a day ago, or that the store dates not at all, is held back.
// A URL hardcoded in a page, a file of the repository outside the collections or an older revision a revert brings back is not seen: the editor confirms before anything goes.
export async function unusedUploads(): Promise<UploadScan> {
  const blocked: string[] = []
  // Only the names: a loaded collection's loader runs once, in `entries`, and not again to count its entries.
  const listed = await collections({ counts: false })
  const folders = [...new Set(listed.map(collection => uploadFolder(collection.name)))].filter(folder => !PRIVATE_FOLDER.test(folder))
  const stored: string[] = []
  const now = Date.now()

  try {
    for (const folder of folders)
      stored.push(...(await files.list({ folder })).filter(file => file.modified !== undefined && now - file.modified.getTime() >= GRACE).map(file => file.key))
  }
  catch (error) {
    log.error('listing the uploads failed', error)

    return { blocked: [wording('cms.uploads.listFailure', 'The files cannot be listed: {reason}', { reason: error instanceof Error ? error.message : String(error) })] }
  }

  const referenced = new Set<string>()

  for (const collection of listed) {
    try {
      for (const entry of await entries(collection.name)) {
        if (entry.data === undefined) {
          blocked.push(wording('cms.uploads.entryParse', '{entry} does not parse', { entry: `${collection.name}/${entry.slug}` }))

          continue
        }

        for (const text of [JSON.stringify(entry.data, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value), entry.body ?? '']) {
          for (const match of text.toLowerCase().matchAll(IDS))
            referenced.add(match[1]!)
        }
      }
    }
    catch (error) {
      log.error(`reading ${collection.name} failed`, error)
      blocked.push(wording('cms.uploads.collectionRead', '{collection} cannot be read', { collection: collection.name }))
    }
  }

  if (blocked.length > 0)
    return { blocked }

  const orphans = stored.toSorted().filter((key) => {
    const id = KEY_ID.exec(key)?.[1]

    return id !== undefined && !referenced.has(id)
  })
  const variants = await files.variants(orphans)
  const unused = orphans.map(key => ({ key, url: files.url(key), variants: variants.get(key) ?? [] }))

  return { unused }
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

  return { deleted, kept }
}
