// Why an `~icons/<set>/<name>` import cannot load, with the closest imports that can, for the build error and `kay check`.

import type { IconSet } from './types'
import { iconData } from './icon-data'
import { isSetPrefix } from './sets'
import { closeWords } from './spelling'

const SUGGESTED = 3

export interface IconLookup {
  /** The set of `prefix`, undefined when it is not installed. */
  set: (prefix: string) => Promise<IconSet | undefined>
  /** The prefixes an app could import from: its own sets and the installed ones. */
  prefixes: () => string[]
}

function didYouMean(specifiers: string[]): string {
  return specifiers.length > 0 ? `Did you mean ${specifiers.join(', ')}? ` : ''
}

/** The problem with importing `name` from `prefix`, `where` naming the importer; undefined when the icon exists. */
export async function iconProblem(prefix: string, name: string, where: string, lookup: IconLookup): Promise<string | undefined> {
  const set = await lookup.set(prefix)
  if (set !== undefined) {
    if (iconData(set, name) !== undefined)
      return undefined
    // Imported here, as it reads the word table: only a failing import pays for it.
    const { findIcons } = await import('./search')
    // A mistyped import is closest to a whole name; the search fills in names sharing its words.
    const names = [...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})]
    const closest = [...new Set([...closeWords(name, names), ...findIcons(set, name, { limit: SUGGESTED })])].slice(0, SUGGESTED).map(found => `~icons/${prefix}/${found}`)
    return `no icon "${name}" in set "${prefix}"${where}. ${didYouMean(closest)}Search with kay icons-find <words>.`
  }
  if (!isSetPrefix(prefix))
    return `"${prefix}" is not an icon set name${where}: write ~icons/<set>/<name>, such as ~icons/tabler/home.`

  const closest: string[] = []
  for (const other of closeWords(prefix, lookup.prefixes())) {
    const otherSet = await lookup.set(other)
    if (otherSet !== undefined && iconData(otherSet, name) !== undefined)
      closest.push(`~icons/${other}/${name}`)
  }
  return `no icon set "${prefix}" is installed${where}. ${didYouMean(closest)}Otherwise install @iconify-json/${prefix}, or add it to icons({ sets }) or icons({ dirs }).`
}
