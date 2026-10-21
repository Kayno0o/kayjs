import type { MissingPath, RuntimeRedirect } from 'kay/library'
import { addRuntimeRedirect, clearMissing, configuredRedirects, dismissMissing, RedirectRefusedError, removeRuntimeRedirect, runtimeRedirects, sitePaths, unansweredPaths } from 'kay/library'
import { wording } from 'kay/words'
import { log } from './log'

// The most paths the screen lists: the file keeps 1000, and the island sends every row it shows.
export const SHOWN = 200
const REFERRERS_SHOWN = 3
// The most paths offered for a target at once: the box asks again as more is typed, so none is out of reach.
const PATHS_OFFERED = 50

// The most rows a bulk action sends.
export const MAX_BULK = 1000
const MINUTE_END = 16

export type RedirectStatus = 301 | 302 | 307 | 308 | 410

export interface MissingRow {
  path: string
  hits: number
  // The last visit in UTC, to the minute: `2026-10-17 12:00`.
  lastSeen: string
  // The pages of the site that linked to the path, most first.
  pages: string[]
  // The hosts of other sites visitors came from, most first, cut short with `...`.
  from: string
  // Where the path likely meant to go, with why that is thought.
  target: string | undefined
  reason: string | undefined
  // The entry to paste in `redirects` of kay.config.ts, for a path with a target.
  line: string | undefined
}

// A redirect added from the screen, as it is listed with its Remove button.
export interface AddedRedirect {
  from: string
  // Empty for a 410.
  to: string
  status: RedirectStatus
  // When it was added, in UTC.
  at: string
}

// A redirect of kay.config.ts, which the screen lists and does not change.
export interface ConfiguredRedirect {
  from: string
  to: string
  status: number
}

export type MissingScreen = { rows: MissingRow[], total: number, added: AddedRedirect[], configured: ConfiguredRedirect[] } | { failure: string }

// A time as the screen words it, in UTC so a server and an editor in two zones read the same.
function minute(time: number): string {
  return new Date(time).toISOString().slice(0, MINUTE_END).replace('T', ' ')
}

function quoted(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll('\'', '\\\'')}'`
}

function reasonText(reason: MissingPath['reason']): string | undefined {
  const words = {
    spelling: () => wording('cms.missing.spelling', 'Spelled differently'),
    locale: () => wording('cms.missing.locale', 'In another locale'),
    slug: () => wording('cms.missing.slug', 'Same slug elsewhere'),
    similar: () => wording('cms.missing.similar', 'Near typo'),
  }

  return reason === undefined ? undefined : words[reason]()
}

function hostsOf(referrers: MissingPath['referrers']): string {
  const hosts = [...new Set(referrers.filter(({ page }) => page === undefined).map(({ host }) => host))]

  return hosts.slice(0, REFERRERS_SHOWN).join(', ') + (hosts.length > REFERRERS_SHOWN ? ', ...' : '')
}

// The paths worded for the screen, most hit first as the store gives them.
export function missingRows(paths: MissingPath[]): { rows: MissingRow[], total: number } {
  const rows = paths.slice(0, SHOWN).map(({ path, hits, lastAt, referrers, target, reason }) => ({
    path,
    hits,
    lastSeen: minute(lastAt),
    pages: [...new Set(referrers.flatMap(({ page }) => page === undefined ? [] : [page]))].slice(0, REFERRERS_SHOWN),
    from: hostsOf(referrers),
    target,
    reason: target === undefined ? undefined : reasonText(reason),
    line: target === undefined ? undefined : `${quoted(path)}: ${quoted(target)},`,
  }))

  return { rows, total: paths.length }
}

// What the production server recorded, minus the paths a redirect answers; a store that cannot be read says so and logs why.
export function readMissing(): MissingScreen {
  try {
    return {
      ...missingRows(unansweredPaths()),
      added: runtimeRedirects().map(({ from, to, status, addedAt }: RuntimeRedirect) => ({ from, to, status, at: minute(addedAt) })),
      configured: configuredRedirects(),
    }
  }
  catch (error) {
    log.warn('the paths visitors found nothing at cannot be read', error)

    return { failure: wording('cms.missing.failure', 'The recorded paths cannot be read: see the server\'s log.') }
  }
}

// The paths of the site holding the text typed, for a target box to offer.
export function sitePathsLike(text: string): string[] {
  const wanted = text.trim().toLowerCase()

  return sitePaths().filter(path => path.toLowerCase().includes(wanted)).slice(0, PATHS_OFFERED)
}

// Adds the redirect to the set the server reads while it runs, which forgets the path as missing; the reason it was refused, worded, or undefined once added.
// A 307, which browsers do not keep, so the editor can still undo it; 308 is permanent, and 410 says the path is gone for good, with no target. A 301 or 302 stored before keeps its status when edited.
// A path that has a redirect already takes the new target and status: that is how one is edited.
export function addRedirect(from: string, to: string, status: RedirectStatus = 307): string | undefined {
  try {
    addRuntimeRedirect(from, to, { status })

    return undefined
  }
  catch (error) {
    if (error instanceof RedirectRefusedError)
      return error.message

    log.warn(`the redirect from ${from} was not added`, error)

    return wording('cms.redirects.failure', 'The redirect could not be added: see the server\'s log.')
  }
}

// Removes the redirects, so their paths answer 404 again; how many there were.
export function removeRedirects(froms: string[]): number {
  return froms.filter(from => removeRuntimeRedirect(from)).length
}

// Forgets the paths in the list, which come back if a visitor asks for them again; how many were listed.
export function dismissPaths(paths: string[]): number {
  return dismissMissing(paths)
}

// Forgets every listed path; how many there were.
export function clearPaths(): number {
  return clearMissing()
}
