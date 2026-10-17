// The query param a search hit's `href` carries, which the page it opens marks the words of.
export const ARRIVAL_PARAM = 'kay_q'
export const ARRIVAL_HIGHLIGHT = 'kay-search'

// Whether a URL's query asks for the marking.
export function arrives(search: string): boolean {
  return search.includes(`${ARRIVAL_PARAM}=`)
}

// Marks the words a search hit's page was opened for, loading the code only for a page that asks, or one holding marks to clear; a failed load costs the marks alone.
export async function arrive(search: string = location.search): Promise<void> {
  if (!arrives(search) && !CSS.highlights?.has(ARRIVAL_HIGHLIGHT))
    return

  try {
    (await import('./search-arrival')).markArrival(search)
  }
  catch {}
}
