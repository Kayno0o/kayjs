import type { EntryRef } from './kay/contract'
import type { Adoption } from './media'
import { files, typeOfName } from 'kay/server'
import { log } from './log'
import { adoptUploads, contentId, isUploadKey, MEDIA_FOLDER } from './media'
import { idOf, readUploads } from './orphans'
import { collectionNamed, entryOf, saveEntry, versionOf } from './store'

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g

// The text with each older key replaced by its copy's, wherever a path holds it: a key is not part of a longer word or path.
function swapKeys(text: string, swaps: ReadonlyMap<string, string>, pattern: RegExp): string {
  return text.replace(pattern, key => swaps.get(key) ?? key)
}

// The value with its strings swapped, however deep in lists, blocks and groups; the value itself when none holds an older key, so a change is told by identity.
function swapIn(value: unknown, swaps: ReadonlyMap<string, string>, pattern: RegExp): unknown {
  if (typeof value === 'string') {
    const next = swapKeys(value, swaps, pattern)

    return next === value ? value : next
  }

  if (Array.isArray(value)) {
    const items = value.map(item => swapIn(item, swaps, pattern))

    return items.some((item, i) => item !== value[i]) ? items : value
  }

  if (typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const record = value as Record<string, unknown>
    const entries = Object.entries(record).map(([key, each]) => [key, swapIn(each, swaps, pattern)] as const)

    return entries.some(([key, each]) => each !== record[key]) ? Object.fromEntries(entries) : value
  }

  return value
}

interface Plan {
  ref: EntryRef
  // The older keys this entry names, with the key of their copy.
  swaps: Map<string, string>
}

export interface Migrated {
  // Older uploads whose copy every entry naming them now points at.
  moved: number
  // Older uploads copied but still named by an entry that could not be saved; the next boot tries them again.
  pending: number
}

// Copies every older per-collection upload that an entry names into the shared folder, named by its hash, and points the entries naming it at the copy, so an app ends on one layout without writing anything.
// An entry is saved against the version it was read at, through the configured saver, so another server running this at once, or a save made since, makes it skip that entry and leaves the upload for the next boot. The older file stays where it was: pages the site has not rebuilt from still name it, and it is listed by the unused-uploads screen once no entry does.
export async function migrateUploads(): Promise<Migrated> {
  const read = await readUploads()

  if ('blocked' in read) {
    log.warn(`the older uploads were not moved to the shared folder, as ${read.blocked.join('; ')}`)

    return { moved: 0, pending: 0 }
  }

  const older = read.stored.filter((file) => {
    const id = idOf(file.key)

    return id !== undefined && !file.key.startsWith(`${MEDIA_FOLDER}/`) && isUploadKey(file.key) && read.usedBy.has(id)
  })
  const adoptions = new Map<string, Adoption>()
  const plans = new Map<string, Plan>()

  for (const file of older) {
    const stored = await files.get(file.key)

    if (stored === undefined)
      continue

    // The stored bytes are the ones the first upload already stripped; the name's extension keeps the type the key had.
    const blob = new File([await stored.arrayBuffer()], file.key.split('/').at(-1)!, { type: typeOfName(file.key) })
    const to = await files.put(blob, { folder: MEDIA_FOLDER, id: await contentId(blob) })

    adoptions.set(file.key, { from: file.key, to, size: blob.size, at: file.modified?.getTime(), done: false })

    for (const ref of read.usedBy.get(idOf(file.key)!)!.values()) {
      const name = `${ref.collection}/${ref.slug}/${ref.locale ?? ''}`
      const plan = plans.get(name) ?? { ref, swaps: new Map<string, string>() }

      plan.swaps.set(file.key, to)
      plans.set(name, plan)
    }
  }

  const failed = new Set<string>()

  for (const { ref, swaps } of plans.values()) {
    if (!await point(ref, swaps)) {
      for (const key of swaps.keys())
        failed.add(key)
    }
  }

  const done = [...adoptions.values()].map(adoption => ({ ...adoption, done: !failed.has(adoption.from) }))

  await adoptUploads(done)

  return { moved: done.filter(each => each.done).length, pending: failed.size }
}

// Saves the entry with its older keys swapped for their copies; false when it could not be, or names an older upload in a form the swap does not reach.
async function point(ref: EntryRef, swaps: ReadonlyMap<string, string>): Promise<boolean> {
  try {
    const collection = await collectionNamed(ref.collection)
    const now = await entryOf(ref, collection)

    if (now?.data === undefined)
      return false

    const pattern = new RegExp(`(?<![\\w-])(?:${[...swaps.keys()].map(key => key.replace(REGEXP_SPECIAL, '\\$&')).join('|')})(?![\\w-])`, 'g')
    const data = swapIn(now.data, swaps, pattern) as Record<string, unknown>
    const body = now.body === undefined ? undefined : swapKeys(now.body, swaps, pattern)

    if (data === now.data && body === now.body)
      return false

    const version = collection.kind === 'loaded' ? undefined : await versionOf(ref) ?? now.version
    const outcome = await saveEntry({ ...ref, data, body }, { version, verb: 'update', bodyKept: true })

    if ('saved' in outcome)
      return true

    log.warn(`${ref.collection}/${ref.slug} was not pointed at the shared uploads: ${'issues' in outcome ? outcome.issues.map(issue => issue.message).join('; ') : ''}`)

    return false
  }
  catch (error) {
    log.warn(`${ref.collection}/${ref.slug} could not be pointed at the shared uploads`, error)

    return false
  }
}
