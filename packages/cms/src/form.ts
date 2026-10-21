import type { Signal } from 'kay'
import type { Drafts } from './drafts'
import type { EntryRef, ScreenCollection, StoredEntry } from './kay/contract'
import type { SlugReport } from './slug'
import { call, effect, guardLeave, navigate, signal, untrack } from 'kay'
import { wording } from 'kay/words'
import slugsApi from './api/slugs'
import { publishTime, unpublishTime, useGoesLive } from './datetime'
import { createDrafts } from './drafts'
import { deleteSaved, refuseUnsaved, saveDraft, showRefusal } from './editor/save'
import { saveShortcut } from './editor/shortcut'
import { shipWords } from './editor/words'
import { fieldsOf } from './fields'
import { collectionPath, collectionTitle, entryPath, entryTitle, SINGLE_SLUG } from './listing'
import { checkSlug, slugify } from './slug'

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
  // Whether a new entry's slug is written from its title as the title is typed, which typing in the slug box turns off and clearing it turns on again; a saved entry's slug is never touched, nor a loaded collection's.
  suggestsSlug: Signal<boolean>
  // Whether a title is typed but gives no letter or digit to write the slug from, which the slug box then says.
  slugNeedsTyping: () => boolean
  // Reads the slugs the collection holds, once the screen has loaded, for `slugReport`.
  readSlugs: () => Promise<void>
  // Takes the text typed in the slug box, cleaned the way a folder entry's slug is (accents, spaces and case).
  typeSlug: (text: string) => void
  // Where the new entry's slug lands among the slugs the collection holds, once they are read; undefined before, and for an entry that is saved or single.
  slugReport: () => SlugReport | undefined
  saving: Signal<boolean>
  // Whether the entry has edits not saved yet.
  dirty: () => boolean
  // Whether Save has something to do: edits to save, or a new entry to create, and no save on its way.
  canSave: () => boolean
  // The last save that went through, when it was (`Date.now()`) and whether the site shows it only once it has rebuilt; undefined before the first.
  savedAt: () => { at: number, rebuilding: boolean } | undefined
  stored: StoredEntry | undefined
  isDraft: () => boolean
  // When a published entry whose `publishAt` date is ahead goes live, in the editor's time zone (UTC until the browser says it), as the form holds it now; gone once the date passes, with no reload.
  scheduled: () => string | undefined
  // When a published entry whose `unpublishAt` date is ahead comes down, in the editor's time zone, as the form holds it now; gone once the date passes, with no reload.
  ends: () => string | undefined
  // Whether a published entry's `unpublishAt` date passed: the site no longer shows it.
  ended: () => boolean
  save: () => Promise<void>
  // Publish, Unpublish, Publish now and Clear schedule change the entry alone: with edits not saved yet they refuse, saving nothing, and a refused save leaves the form as it was.
  publish: () => Promise<void>
  unpublish: () => Promise<void>
  publishNow: () => Promise<void>
  unschedule: () => Promise<void>
  clearEnd: () => Promise<void>
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
  const slug = signal(first?.slug ?? (collection.single ? SINGLE_SLUG : ''))
  // kay files each entry of a localized collection under one of the site's locales.
  const newLocale = signal(locale ?? collection.locales?.[0] ?? '')
  const saving = signal(false)
  // A folder entry's slug is cleaned as it is typed; a loaded collection's is the loader's to judge, so it stays as typed.
  const cleans = collection.kind === 'folder'
  const suggestsSlug = signal(!first && !collection.single && cleans)
  const known = signal<{ slug: string, locale?: string | undefined }[]>()
  const titleKey = fieldsOf(collection.schema).find(field => field.kind === 'text')?.key.toString()

  // The slugs only flag a taken one and a folder typo: the server decides, so a list that cannot be read changes nothing.
  async function readSlugs(): Promise<void> {
    if (first || collection.single)
      return

    try {
      known.set(await call(slugsApi, '/:collection', { params: { collection: collection.name } }))
    }
    catch {
      known.set(undefined)
    }
  }

  // The slug follows the title until the slug is typed in.
  effect(() => {
    if (!suggestsSlug() || titleKey === undefined)
      return

    const title = drafts.value(ref, titleKey)

    untrack(() => {
      slug.set(typeof title === 'string' ? slugify(title, { final: true }) : '')
      drafts.dismissWhere(ref, issue => issue.key === 'slug')
    })
  })

  function typeSlug(text: string): void {
    const typed = cleans ? slugify(text) : text

    slug.set(typed)
    suggestsSlug.set(cleans && typed === '')
    drafts.dismissWhere(ref, issue => issue.key === 'slug')
  }

  const slugNeedsTyping = () => {
    const title = titleKey === undefined ? undefined : drafts.value(ref, titleKey)

    return suggestsSlug() && typeof title === 'string' && title.trim() !== '' && slug() === ''
  }

  const slugReport = () => {
    const list = known()

    if (first || collection.single || list === undefined)
      return undefined

    const locale = collection.localized ? newLocale() : undefined

    return checkSlug(slug(), list.filter(entry => entry.locale === locale).map(entry => entry.slug))
  }

  drafts.open({ ...ref, data: first?.data ?? collection.seed ?? {}, body: first?.body }, first?.version)
  guardLeave(() => !saving() && drafts.changed(ref))

  // The entry as it is now, the one the form opened with once it is gone.
  const stored = () => first && (read() ?? first)
  // The entry's own title, its slug beneath when that is not the title; a new entry has neither.
  const nameOf = () => {
    const now = stored()

    // A single collection's entry is the collection: its name, never the entry's slug.
    if (collection.single)
      return collectionTitle(collection)

    return now ? entryTitle(collection, now) : wording('cms.admin.newEntry', 'New entry')
  }
  const subtitleOf = () => {
    const now = stored()

    if (collection.single)
      return undefined

    return now && nameOf() !== now.slug ? slugLine(now) : now?.locale
  }

  const isDraft = () => collection.draftField !== undefined && drafts.value(ref, collection.draftField) === true

  const goesLiveAt = () => !isDraft() && collection.publishField !== undefined ? publishTime(collection, { [collection.publishField]: drafts.value(ref, collection.publishField) }) : undefined
  const scheduled = useGoesLive(goesLiveAt)
  const endsAt = () => !isDraft() && collection.unpublishField !== undefined ? unpublishTime(collection, { [collection.unpublishField]: drafts.value(ref, collection.unpublishField) }) : undefined
  const ends = useGoesLive(endsAt)
  // `ends` reads the clock, so this follows the date passing.
  const ended = () => endsAt() !== undefined && ends() === undefined
  // A text that does not parse keeps Save enabled, so pressing it says what to fix.
  const canSave = () => !saving() && (first === undefined || drafts.changed(ref) || drafts.blocked(ref).length > 0)

  const lastSave = signal<{ at: number, rebuilding: boolean }>()
  const onSaved = ({ rebuilding }: { rebuilding: boolean }) => lastSave.set({ at: Date.now(), rebuilding })

  async function attemptSave(): Promise<boolean> {
    // Ctrl+S and a click on a disabled button's neighbour reach here with nothing to save.
    if (first && !drafts.changed(ref) && drafts.blocked(ref).length === 0)
      return true

    saving.set(true)

    try {
      if (first)
        return await saveDraft(drafts, ref, { onSaved })

      const created = { collection: collection.name, slug: cleans ? slugify(slug(), { final: true }) : slug().trim(), locale: collection.localized ? newLocale() : undefined }

      if (!await saveDraft(drafts, ref, { slug: created.slug, locale: created.locale, create: true, onSaved }))
        return false

      await navigate(entryPath(prefix, created), { replace: true })

      return true
    }
    finally {
      saving.set(false)
    }
  }

  async function saveNow(): Promise<boolean> {
    const saved = await attemptSave()

    // The fields are unlocked by now, so the focus can land in one.
    if (!saved)
      await showRefusal(drafts, ref)

    return saved
  }

  async function save(): Promise<void> {
    await saveNow()
  }

  // Saves one field's new value alone, and puts the field back when the save is refused, so the form never shows what is not stored.
  async function change(field: string | undefined, value: unknown): Promise<void> {
    if (!first || field === undefined || saving())
      return

    if (drafts.changed(ref))
      return refuseUnsaved()

    const before = drafts.value(ref, field)

    drafts.set(ref, field, value)

    if (!await saveNow())
      drafts.set(ref, field, before)
  }

  saveShortcut(async () => {
    if (canSave())
      await save()
  })

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
    suggestsSlug,
    readSlugs,
    typeSlug,
    slugReport,
    slugNeedsTyping,
    saving,
    dirty: () => drafts.changed(ref) || drafts.blocked(ref).length > 0,
    canSave,
    savedAt: () => lastSave(),
    get stored() {
      return stored()
    },
    isDraft,
    scheduled,
    ends,
    ended,
    save,
    publish: async () => change(collection.draftField, false),
    unpublish: async () => change(collection.draftField, true),
    publishNow: async () => change(collection.publishField, new Date().toISOString()),
    unschedule: async () => change(collection.publishField, undefined),
    clearEnd: async () => change(collection.unpublishField, undefined),
    async remove() {
      if (await deleteSaved(ref, drafts.version(ref)))
        await navigate(collectionPath(prefix, collection.name), { replace: true })
    },
    reset: () => drafts.reset(ref),
  }
}
