import type { MissingPath, RuntimeRedirect } from 'kay/library'
import { addRuntimeRedirect, RedirectRefused, removeRuntimeRedirect, runtimeRedirects, unansweredPaths } from 'kay/library'
import { wording } from 'kay/words'
import { log } from './log'

// The most paths the screen lists: the file keeps 1000, and the island sends every row it shows.
export const SHOWN = 200
const REFERRERS_SHOWN = 3

export interface MissingRow {
  path: string
  hits: number
  // The day of the last visit, `2026-10-17`.
  lastSeen: string
  // The hosts visitors came from, most first, cut short with `...`.
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
  to: string
  status: number
}

export type MissingScreen = { rows: MissingRow[], total: number, added: AddedRedirect[] } | { failure: string }

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

// The paths worded for the screen, most hit first as the store gives them.
export function missingRows(paths: MissingPath[]): { rows: MissingRow[], total: number } {
  const rows = paths.slice(0, SHOWN).map(({ path, hits, lastAt, referrers, target, reason }) => ({
    path,
    hits,
    lastSeen: new Date(lastAt).toISOString().slice(0, 10),
    from: referrers.slice(0, REFERRERS_SHOWN).map(({ host }) => host).join(', ') + (referrers.length > REFERRERS_SHOWN ? ', ...' : ''),
    target,
    reason: target === undefined ? undefined : reasonText(reason),
    line: target === undefined ? undefined : `${quoted(path)}: ${quoted(target)},`,
  }))

  return { rows, total: paths.length }
}

// What the production server recorded, minus the paths a redirect answers; a store that cannot be read says so and logs why.
export function readMissing(): MissingScreen {
  try {
    return { ...missingRows(unansweredPaths()), added: runtimeRedirects().map(({ from, to, status }: RuntimeRedirect) => ({ from, to, status })) }
  }
  catch (error) {
    log.warn('the paths visitors found nothing at cannot be read', error)

    return { failure: wording('cms.missing.failure', 'The recorded paths cannot be read: see the server\'s log.') }
  }
}

// Adds the redirect to the set the server reads while it runs, which forgets the path as missing; the reason it was refused, worded, or undefined once added.
export function addRedirect(from: string, to: string): string | undefined {
  try {
    addRuntimeRedirect(from, to)

    return undefined
  }
  catch (error) {
    if (error instanceof RedirectRefused)
      return error.message

    log.warn(`the redirect from ${from} was not added`, error)

    return wording('cms.redirects.failure', 'The redirect could not be added: see the server\'s log.')
  }
}

export function removeRedirect(from: string): boolean {
  return removeRuntimeRedirect(from)
}
