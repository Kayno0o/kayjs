// The query param a search hit's `href` carries, which the page it opens marks the words of.
export const ARRIVAL_PARAM = 'kay_q'
export const ARRIVAL_HIGHLIGHT = 'kay-search'

// Whether a URL's query asks for the marking.
export function arrives(search: string): boolean {
  return search.includes(`${ARRIVAL_PARAM}=`)
}

// Marks the words a search hit's page was opened for, loading the code only for a page that asks, or one holding marks to clear; `from` is where the window was scrolled to when the page showed, and a visitor who moved it since is left where they are. A failed load costs the marks alone.
export async function arrive(search: string, from: number): Promise<void> {
  if (!arrives(search) && !CSS.highlights?.has(ARRIVAL_HIGHLIGHT))
    return

  try {
    const { markArrival } = await import('./search-arrival')

    // A page swapped in while the code loaded marks its own words, or none.
    if (location.search === search)
      markArrival(search, location.hash, from)
  }
  catch {}
}
