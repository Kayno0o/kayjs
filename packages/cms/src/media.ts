import { files } from 'kay/server'
import { log } from './log'

// What the library knows of an upload beyond its key: the name it came with, which a rename changes, its size, who sent it and when.
export interface MediaRecord {
  name: string
  size: number
  by?: string | undefined
  at: number
}

// Where every new upload goes, whatever the collection, named by the hash of its bytes so a file sent twice is stored once.
// The folders of the collections an older release filled keep working and are listed with it.
export const MEDIA_FOLDER = 'cms-media'

// The index sits in a private key, served to no link, and is read through the file store as everything else is.
const INDEX_ID = 'cms-media-index'
const INDEX_KEY = `private/${INDEX_ID}.json`
const HASH_CHARS = 20

// One write at a time per process: the index is read, changed and written back, and two uploads landing together would lose one. Another replica's write can still race; a record lost that way only leaves the upload shown by its key.
let writing: Promise<void> = Promise.resolve()

export async function mediaIndex(): Promise<Record<string, MediaRecord>> {
  try {
    const stored = await files.get(INDEX_KEY)

    return stored === undefined ? {} : await stored.json() as Record<string, MediaRecord>
  }
  catch (error) {
    log.error('reading the media index failed', error)

    return {}
  }
}

// `update` answers false when it changed nothing, so the index is not written.
async function change(update: (index: Record<string, MediaRecord>) => boolean): Promise<void> {
  const before = writing
  let release!: () => void

  writing = new Promise<void>((resolve) => {
    release = resolve
  })

  await before

  try {
    const index = await mediaIndex()

    if (update(index))
      await files.put(new Blob([JSON.stringify(index)], { type: 'application/json' }), { private: true, id: INDEX_ID })
  }
  finally {
    release()
  }
}

// The hash of the bytes sent, which names the file: the same bytes always give the same key.
export async function contentId(file: Blob): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')

  hasher.update(await file.arrayBuffer())

  return hasher.digest('hex').slice(0, HASH_CHARS)
}

// Stores an upload in the shared folder under its hash and records it; sending the same bytes again answers the same key and keeps the name it first came with.
export async function storeUpload(file: File, by?: string): Promise<string> {
  const key = await files.put(file, { folder: MEDIA_FOLDER, id: await contentId(file) })

  try {
    await change((index) => {
      if (key in index)
        return false

      index[key] = { name: file.name || key.split('/').at(-1)!, size: file.size, ...by !== undefined && { by }, at: Date.now() }

      return true
    })
  }
  catch (error) {
    // The file is stored and works; only its record is missing.
    log.error('recording the upload failed', error)
  }

  return key
}

// A key the CMS's folders hold: never a private one, and with the 20 hex digits of an id.
const UPLOAD_KEY = /^(?!private\/)(?:[\w-]+\/)+[\da-f]{20}(?:\.\d+x\d+(?:-[\da-f]{6})?)?\.[a-z\d]{1,10}$/i

export function isUploadKey(key: string): boolean {
  return UPLOAD_KEY.test(key)
}

// Renames what the library shows for an upload, a legacy one with no record included; the key, and so every reference to it, is unchanged. False when no such file is stored.
export async function renameUpload(key: string, name: string): Promise<boolean> {
  const stored = isUploadKey(key) ? await files.get(key) : undefined

  if (stored === undefined)
    return false

  await change((index) => {
    index[key] = { size: stored.size, at: 0, ...index[key], name }

    return true
  })

  return true
}

export async function forgetUploads(keys: string[]): Promise<void> {
  await change((index) => {
    const known = keys.filter(key => key in index)

    for (const key of known)
      delete index[key]

    return known.length > 0
  })
}
