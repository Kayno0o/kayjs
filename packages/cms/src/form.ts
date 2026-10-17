import type { Signal } from 'kay'
import type { Drafts } from './drafts'
import type { EntryRef, ScreenCollection, StoredEntry } from './kay/contract'
import { guardLeave, navigate, signal } from 'kay'
import { wording } from 'kay/words'
import { createDrafts } from './drafts'
import { deleteSaved, saveDraft } from './editor/save'
import { shipWords } from './editor/words'
import { collectionPath, entryPath, entryTitle } from './listing'

// What the parts of an entry's form read: the drafts, the entry they edit, its collection, and which fields the screen renders.
export interface FormScope {
  drafts: Drafts
  entry: EntryRef
  collection: ScreenCollection
  // Why the entry's file does not parse, when it does not.
  problem?: string | undefined
  shown: Shown
}

// The fields a screen renders, so an issue on one it does not render is still shown.
export interface Shown {
  // Marks a field rendered until the returned function is called.
  add: (id: string) => () => void
  has: (id: string) => boolean
}

export interface EntryForm extends FormScope {
  prefix: string
  // The entry's title, or New entry; its slug and locale beneath, when that is not the title.
  name: string
  subtitle: string | undefined
  // A new entry's slug and locale, typed in the form.
  slug: Signal<string>
  newLocale: Signal<string>
  saving: Signal<boolean>
  stored: StoredEntry | undefined
  isDraft: () => boolean
  save: () => Promise<void>
  publish: () => Promise<void>
  remove: () => Promise<void>
  reset: () => void
}

export function createShown(): Shown {
  const counts = new Map<string, number>()
  const changes = signal(0)
  let changed = 0

  return {
    add(id) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      changes.set(++changed)

      return () => {
        counts.set(id, (counts.get(id) ?? 1) - 1)
        changes.set(++changed)
      }
    },
    has(id) {
      changes()

      return (counts.get(id) ?? 0) > 0
    },
  }
}

export function formScope(drafts: Drafts, entry: EntryRef, collection: ScreenCollection, problem?: string): FormScope {
  return { drafts, entry, collection, problem, shown: createShown() }
}

function slugLine(entry: StoredEntry): string {
  return entry.locale === undefined ? entry.slug : `${entry.slug} (${entry.locale})`
}

// An entry's form on its own screen, or a new entry's when `entry` is left out: the drafts, the save, publish and delete, and the guard against leaving with edits. Called in a component's script, it is what the default screen runs.
export function createEntryForm({ prefix, collection, entry, locale }: { prefix: string, collection: ScreenCollection, entry?: StoredEntry | undefined, locale?: string | undefined }): EntryForm {
  // Looks up what the form reads only once the page has loaded, so the page sends it.
  shipWords()

  // Nothing on this screen shows the entry rendered, so a change waits for no draft render.
  const drafts = createDrafts({ show: async () => Promise.resolve({}) })
  // A new entry's draft is kept under no slug until it is saved under the one typed.
  const ref: EntryRef = { collection: collection.name, slug: entry?.slug ?? '', locale: entry?.locale ?? locale }
  const slug = signal(entry?.slug ?? '')
  // kay files each entry of a localized collection under one of the site's locales.
  const newLocale = signal(locale ?? collection.locales?.[0] ?? '')
  const saving = signal(false)

  drafts.open({ ...ref, data: entry?.data ?? {}, body: entry?.body }, entry?.version)
  guardLeave(() => !saving() && drafts.changed(ref))

  // The entry's own title, its slug beneath when that is not the title; a new entry has neither.
  const name = entry ? entryTitle(collection, entry) : wording('cms.admin.newEntry', 'New entry')
  const subtitle = entry && name !== entry.slug ? slugLine(entry) : entry?.locale

  async function save(): Promise<void> {
    saving.set(true)

    try {
      if (entry) {
        await saveDraft(drafts, ref)

        return
      }

      const created = { collection: collection.name, slug: slug().trim(), locale: collection.localized ? newLocale() : undefined }

      if (await saveDraft(drafts, ref, { slug: created.slug, locale: created.locale, create: true }))
        await navigate(entryPath(prefix, created), { replace: true })
    }
    finally {
      saving.set(false)
    }
  }

  return {
    ...formScope(drafts, ref, collection, entry?.problem),
    prefix,
    name,
    subtitle,
    slug,
    newLocale,
    saving,
    stored: entry,
    isDraft: () => collection.draftField !== undefined && drafts.value(ref, collection.draftField) === true,
    save,
    async publish() {
      if (collection.draftField === undefined)
        return

      drafts.set(ref, collection.draftField, false)
      await save()
    },
    async remove() {
      if (await deleteSaved(ref, drafts.version(ref)))
        await navigate(collectionPath(prefix, collection.name), { replace: true })
    },
    reset: () => drafts.reset(ref),
  }
}
