import type { IconProps } from 'kay/icons'
import type { IconSlot } from './defaults'

interface PaletteBase {
  label: string
  // The heading it sits under, and a word a query can match.
  group: string
  icon?: IconSlot | IconProps
  // Extra words a query matches, never shown.
  keywords?: string
}

// A place to go: followed in the same tab, or a new one with Ctrl or Cmd held, or always when `external`.
export interface PaletteLink extends PaletteBase {
  href: string
  external?: boolean
}

// Something to do, run once the palette has closed.
export interface PaletteAction extends PaletteBase {
  onSelect: () => void
}

export type PaletteEntry = PaletteLink | PaletteAction

// A section of the unfiltered list, under its heading.
export interface PaletteSection {
  group: string
  entries: PaletteEntry[]
}

// The heading the recently followed links sit under, first, while the query is empty.
export const RECENT_GROUP = 'Recent'

export function isPaletteLink(entry: PaletteEntry): entry is PaletteLink {
  return 'href' in entry
}

// Every character of the query in order: a run and a word start each add, so "atome" still finds "notes automate".
function subsequenceScore(text: string, query: string): number {
  let from = 0
  let run = 0
  let total = 0

  for (const character of query) {
    const at = text.indexOf(character, from)

    if (at === -1)
      return 0

    run = at === from ? run + 1 : 0
    total += 1 + run * 2 + (at === 0 || text[at - 1] === ' ' ? 3 : 0)
    from = at + 1
  }

  return total
}

// How well `query`, already lowercased and trimmed, matches an entry, 0 for not at all.
// The tiers never overlap: a label starting with it, then a label holding it, then its group or keywords holding it, then its characters in order, group first, so "aitext" finds AI's Text.
export function paletteScore(entry: Pick<PaletteBase, 'label' | 'group' | 'keywords'>, query: string): number {
  const label = entry.label.toLowerCase()
  const haystack = `${entry.group} ${label} ${entry.keywords ?? ''}`.toLowerCase()

  if (label.startsWith(query))
    return 1000

  if (label.includes(query))
    return 800

  if (haystack.includes(query))
    return 600

  return Math.min(subsequenceScore(haystack, query), 599)
}

// The entries matching `query`, best first, ties kept in `groups` order and then by label.
export function paletteMatches(entries: PaletteEntry[], query: string, groups: string[] = []): PaletteEntry[] {
  const needle = query.trim().toLowerCase()
  const rank = groupRank(groups)

  return entries
    .map(entry => ({ entry, score: paletteScore(entry, needle) }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || rank(a.entry.group) - rank(b.entry.group) || a.entry.label.localeCompare(b.entry.label))
    .map(match => match.entry)
}

// The unfiltered list: the links named in `recent` that still exist, in that order, then every entry under its group, groups in `groups` order and the rest after them as they come.
export function paletteSections(entries: PaletteEntry[], recent: string[] = [], groups: string[] = []): PaletteSection[] {
  const byHref = new Map(entries.filter(isPaletteLink).map(entry => [entry.href, entry]))
  const recents = recent.flatMap(href => byHref.get(href) ?? [])
  const sections = [...Map.groupBy(entries, entry => entry.group)]
    .map(([group, members]) => ({ group, entries: members }))
    .sort((a, b) => groupRank(groups)(a.group) - groupRank(groups)(b.group))

  return recents.length > 0 ? [{ group: RECENT_GROUP, entries: recents }, ...sections] : sections
}

// `recent` with `href` moved to the front, at most `limit` long.
export function withRecent(recent: string[], href: string, limit = 8): string[] {
  return [href, ...recent.filter(entry => entry !== href)].slice(0, limit)
}

function groupRank(groups: string[]): (group: string) => number {
  return (group) => {
    const index = groups.indexOf(group)

    return index === -1 ? groups.length : index
  }
}
