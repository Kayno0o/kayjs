import type { Signal } from 'kay'
import type { Drafts } from './drafts'
import type { EntryRef, ScreenCollection, StoredEntry } from './kay/contract'
import { effect, guardLeave, navigate, onCleanup, signal } from 'kay'
import { wording } from 'kay/words'
import { goesLive, publishTime, useEditorZone } from './datetime'
import { createDrafts } from './drafts'
import { deleteSaved, saveDraft } from './editor/save'
import { shipWords } from './editor/words'
import { collectionPath, entryPath, entryTitle } from './listing'

// The longest wait a timer holds, 2^31 - 1 milliseconds, beyond which it fires at once.
const MAX_TIMER_MS = 2_147_483_647

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
  // When a published entry whose `publishAt` date is ahead goes live, in the editor's time zone (UTC until the browser says it), as the form holds it now; gone once the date passes, with no reload.
  scheduled: () => string | undefined
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
// `entry` may be a function returning it, read each time the form needs it: for a screen that stays when the page refreshes in place (a `persist` island) and takes new props, `entry: () => all.entry`, so `stored`, `name` and `subtitle` follow the refreshed entry.
export function createEntryForm({ prefix, collection, entry, locale }: { prefix: string, collection: ScreenCollection, entry?: StoredEntry | undefined | (() => StoredEntry | undefined), locale?: string | undefined }): EntryForm {
  const read = typeof entry === 'function' ? entry : () => entry
  const first = read()

  // Looks up what the form reads only once the page has loaded, so the page sends it.
  shipWords()

  // Nothing on this screen shows the entry rendered, so a change waits for no draft render.
  const drafts = createDrafts({ show: async () => Promise.resolve({}) })
  // A new entry's draft is kept under no slug until it is saved under the one typed.
  const ref: EntryRef = { collection: collection.name, slug: first?.slug ?? '', locale: first?.locale ?? locale }
  const slug = signal(first?.slug ?? '')
  // kay files each entry of a localized collection under one of the site's locales.
  const newLocale = signal(locale ?? collection.locales?.[0] ?? '')
  const saving = signal(false)

  drafts.open({ ...ref, data: first?.data ?? {}, body: first?.body }, first?.version)
  guardLeave(() => !saving() && drafts.changed(ref))

  // The entry as it is now, the one the form opened with once it is gone.
  const stored = () => first && (read() ?? first)
  // The entry's own title, its slug beneath when that is not the title; a new entry has neither.
  const nameOf = () => {
    const now = stored()

    return now ? entryTitle(collection, now) : wording('cms.admin.newEntry', 'New entry')
  }
  const subtitleOf = () => {
    const now = stored()

    return now && nameOf() !== now.slug ? slugLine(now) : now?.locale
  }

  const isDraft = () => collection.draftField !== undefined && drafts.value(ref, collection.draftField) === true

  const zone = useEditorZone()
  // Moves on each time a timer woke the badge, which reads it.
  const woken = signal(0)
  const goesLiveAt = () => !isDraft() && collection.publishField !== undefined ? publishTime(collection, { [collection.publishField]: drafts.value(ref, collection.publishField) }) : undefined

  // Wakes the badge as the date passes; a timer holds 24 days at most, and one waking early finds the date still ahead and waits again.
  effect(() => {
    woken()

    const at = goesLiveAt()
    const wait = at === undefined ? 0 : at - Date.now()

    if (wait <= 0)
      return

    const timer = setTimeout(() => woken.set(woken() + 1), Math.min(wait, MAX_TIMER_MS))

    onCleanup(() => clearTimeout(timer))
  })

  async function save(): Promise<void> {
    saving.set(true)

    try {
      if (first) {
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
    ...formScope(drafts, ref, collection),
    prefix,
    get problem() {
      return stored()?.problem
    },
    get name() {
      return nameOf()
    },
    get subtitle() {
      return subtitleOf()
    },
    slug,
    newLocale,
    saving,
    get stored() {
      return stored()
    },
    isDraft,
    scheduled: () => {
      woken()

      const at = goesLiveAt()

      return at === undefined ? undefined : goesLive(at, Date.now(), zone())
    },
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
