import type { Intent, Swap } from './navigation'

// How a swap goes, read off its intent: the one place a swap decides it.
export interface Policy {
  // `push` adds a history entry, `replace` takes the current one's place, `none` leaves history alone, as going back does.
  history: 'push' | 'replace' | 'none'
  // Where the window scrolls to once swapped: the top or the URL's hash, the position the entry saved, or where it is.
  scroll: 'top' | 'saved' | 'keep'
  // What gets focus: the new page's autofocus field or heading, its title announced, the element focused before, or the refused form's field.
  focus: 'page' | 'kept' | 'refused'
  // The islands kept: those marked `persist`, or besides them every one whose component and props did not change.
  islands: 'persist' | 'unchanged'
  // Whether the page changes through a view transition, once its stylesheets opt in.
  transition: boolean
}

const POLICIES: Record<Intent, Policy> = {
  visit: { history: 'push', scroll: 'top', focus: 'page', islands: 'persist', transition: true },
  query: { history: 'push', scroll: 'keep', focus: 'kept', islands: 'persist', transition: true },
  traverse: { history: 'none', scroll: 'saved', focus: 'page', islands: 'persist', transition: true },
  refresh: { history: 'none', scroll: 'keep', focus: 'kept', islands: 'unchanged', transition: false },
  redirect: { history: 'replace', scroll: 'keep', focus: 'kept', islands: 'persist', transition: true },
  refusal: { history: 'none', scroll: 'keep', focus: 'refused', islands: 'persist', transition: true },
  error: { history: 'none', scroll: 'top', focus: 'page', islands: 'persist', transition: true },
}

// What the swaps under way share, which each one reads before it acts: `navigation.current` is the token of the latest one started, which every swap that is not it gives way to.
export const inFlight: {
  // The fetch of the latest navigation, which a newer one to another page cancels: its page would never be shown. One for the same page leaves it, as it always did.
  fetch?: { controller: AbortController, key: string } | undefined
  // The swap a link, a query change or a traversal has under way, which a refresh waits for rather than supersedes: the visitor asked for it, and the refresh's page would be the one being left.
  asked?: Promise<void> | undefined
  // The click listener of the view transition running, at most one.
  transition?: ((event: MouseEvent) => void) | undefined
  // Whether the commit under way keeps what was typed into the fields the next page renders as they were, which `kay dev` asks of a refresh for an edit.
  typing: boolean
  // The selects the commit under way found renamed, whose options show what the next page renders.
  renamed: Set<Element>
} = { typing: false, renamed: new Set() }

export const LATE = Symbol('late')

// How long a swap waits for a lazy chunk the fetched page needs, past which it goes on as if the chunk had failed to load.
export const CHUNK_TIMEOUT_MS = 4500

// The intent's policy, with history replaced as the swap asks, and the top for a traversal to an entry that saved no position.
export function policyOf(swap: Swap): Policy {
  const policy = { ...POLICIES[swap.intent] }

  if (swap.replace)
    policy.history = 'replace'

  if (policy.scroll === 'saved' && !swap.saved)
    policy.scroll = 'top'

  if (swap.scroll && policy.scroll !== 'saved')
    policy.scroll = swap.scroll

  if (swap.transition === false)
    policy.transition = false

  return policy
}

// The work's result, or `LATE` once `ms` passed first.
export async function bounded<T>(work: Promise<T>, ms: number): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([work, new Promise<typeof LATE>((resolve) => {
      timer = setTimeout(resolve, ms, LATE)
    })])
  }
  finally {
    clearTimeout(timer)
  }
}
