import type { SourceEntry } from './kay/contract'

export type Direction = 'up' | 'down'

// The number an entry holds in the collection's `order` field, undefined when it holds none.
export function orderValue(entry: Pick<SourceEntry, 'data'>, field: string): number | undefined {
  const value = entry.data?.[field]

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// The entries as `all()` lists them: by their `order` field, those without it last, then by slug and locale; one whose file does not parse comes after all.
export function sortOrdered<T extends Pick<SourceEntry, 'slug' | 'locale' | 'data'>>(entries: T[], field: string): T[] {
  const place = (entry: T) => entry.data === undefined ? Infinity : orderValue(entry, field) ?? Number.MAX_VALUE

  return entries.toSorted((a, b) => {
    const [first, second] = [place(a), place(b)]

    if (first !== second)
      return first < second ? -1 : 1

    if (a.slug !== b.slug)
      return a.slug < b.slug ? -1 : 1

    return (a.locale ?? '') < (b.locale ?? '') ? -1 : 1
  })
}

// The entries one move goes between: those of a locale, whose data reads.
export function movable<T extends Pick<SourceEntry, 'locale' | 'data'>>(entries: T[], locale: string | undefined): T[] {
  return entries.filter(entry => entry.data !== undefined && entry.locale === locale)
}

// The values to write for `slug` to move one place in `group`, already sorted: the two neighbours swap theirs when every value in the group is its own, else the group is numbered from 1. Undefined when the entry is not in the group or already at that end.
export function moveChanges(group: { slug: string, value: number | undefined }[], slug: string, direction: Direction): { slug: string, value: number }[] | undefined {
  const at = group.findIndex(entry => entry.slug === slug)
  const to = direction === 'up' ? at - 1 : at + 1

  if (at < 0 || to < 0 || to >= group.length)
    return undefined

  const [moving, other] = [group[at]!, group[to]!]
  const values = group.map(entry => entry.value)

  if (moving.value !== undefined && other.value !== undefined && values.every(value => value !== undefined) && new Set(values).size === values.length)
    return [{ slug: moving.slug, value: other.value }, { slug: other.slug, value: moving.value }]

  const placed = group.with(at, other).with(to, moving)

  return placed.flatMap((entry, i) => entry.value === i + 1 ? [] : [{ slug: entry.slug, value: i + 1 }])
}
