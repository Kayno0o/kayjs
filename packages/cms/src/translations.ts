import type { Field } from './fields'
import type { CollectionInfo, DataValue, SourceEntry } from './kay/contract'
import { fieldsOf } from './fields'

// What pairs an entry with its translations: its `translationKey` field when it sets one, else its slug, as kay pairs them.
export function pairKey(entry: Pick<SourceEntry, 'slug' | 'data'>): string {
  const given = entry.data?.translationKey

  return typeof given === 'string' && given !== '' ? given : entry.slug
}

// The entries of a localized collection grouped by what pairs them, each group holding its entry per locale.
export function groupEntries(entries: readonly SourceEntry[]): Map<string, Map<string, SourceEntry>> {
  const groups = new Map<string, Map<string, SourceEntry>>()

  for (const entry of entries) {
    if (entry.locale === undefined)
      continue

    const key = pairKey(entry)

    groups.set(key, (groups.get(key) ?? new Map<string, SourceEntry>()).set(entry.locale, entry))
  }

  return groups
}

// The locales a group has no entry in.
export function missingLocales(locales: readonly string[], group: ReadonlyMap<string, SourceEntry>): string[] {
  return locales.filter(locale => !group.has(locale))
}

// The text fields where a translation still says what its source does: `same` as the source's, or `empty` while the source has text. A field `untranslated()` leaves as it is, one with a `format` (an address, an email) and the entry's key fields are not asked for.
export interface FieldGap {
  field: string
  gap: 'same' | 'empty'
}

const TEXT_KINDS = new Set<Field['kind']>(['text', 'textarea', 'markdown'])

export const BODY_FIELD = 'body'

function filled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

// The gap of one text value against its source's, or undefined when it is translated or there is nothing to translate.
export function gapOf(value: unknown, source: unknown): FieldGap['gap'] | undefined {
  if (!filled(source))
    return undefined

  if (!filled(value))
    return 'empty'

  return value.trim() === source.trim() ? 'same' : undefined
}

export function translatable(collection: Pick<CollectionInfo, 'schema'>): Field[] {
  const properties = collection.schema.properties ?? {}

  return fieldsOf(collection.schema).filter(field => TEXT_KINDS.has(field.kind) && field.inputType === undefined && properties[String(field.key)]?.['x-kay-translate'] !== false && properties[String(field.key)]?.format === undefined)
}

// Where `entry` still says what `source` does, field by field and the Markdown body last.
export function fieldGaps(collection: Pick<CollectionInfo, 'schema' | 'body'>, entry: Pick<SourceEntry, 'data' | 'body'>, source: Pick<SourceEntry, 'data' | 'body'>): FieldGap[] {
  const gaps: FieldGap[] = []

  for (const field of translatable(collection)) {
    const gap = gapOf(entry.data?.[field.key], source.data?.[field.key])

    if (gap !== undefined)
      gaps.push({ field: String(field.key), gap })
  }

  const body = collection.body === undefined ? undefined : gapOf(entry.body, source.body)

  return body === undefined ? gaps : [...gaps, { field: BODY_FIELD, gap: body }]
}

// A translation of the entry on screen, as the form shows it.
export interface PairedEntry {
  locale: string
  slug: string
  data?: Record<string, DataValue> | undefined
  body?: string | undefined
}

// The entry on screen against its translations: the site's locales with the slug each is written under, the default locale's entry the form marks untranslated fields against, and the locale shown beside the form.
export interface EntryTranslations {
  locales: { locale: string, slug?: string | undefined }[]
  source?: PairedEntry | undefined
  compare?: PairedEntry | undefined
}

export interface TranslationRow {
  key: string
  // The entry's slug in each locale it exists in.
  slugs: Record<string, string>
  missing: string[]
  // Per locale other than the default's, the fields still as the default locale's.
  gaps: Record<string, FieldGap[]>
}

// A line per entry that lacks a locale or holds a field untranslated, in the order the entries came; an entry fully translated has none.
export function translationReport(collection: Pick<CollectionInfo, 'schema' | 'body' | 'locales' | 'defaultLocale'>, entries: readonly SourceEntry[]): TranslationRow[] {
  const locales = collection.locales ?? []
  const base = collection.defaultLocale ?? locales[0]
  const rows: TranslationRow[] = []

  for (const [key, group] of groupEntries(entries)) {
    const source = base === undefined ? undefined : group.get(base)
    const gaps: Record<string, FieldGap[]> = {}

    if (source !== undefined) {
      for (const [locale, entry] of group) {
        const found = locale === base || entry.data === undefined ? [] : fieldGaps(collection, entry, source)

        if (found.length > 0)
          gaps[locale] = found
      }
    }

    const missing = missingLocales(locales, group)

    if (missing.length > 0 || Object.keys(gaps).length > 0)
      rows.push({ key, slugs: Object.fromEntries([...group].map(([locale, entry]) => [locale, entry.slug])), missing, gaps })
  }

  return rows
}
