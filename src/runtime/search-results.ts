import type { SearchHit, SearchOptions, SearchResults } from './search'
import { effect, ownSignal } from './reactive'

// The search of ./search, which nothing else imports: it loads with the first query holding a word, so an island that may search, such as a palette, weighs nothing on a page until then.
export async function searchSite(query: string, options?: SearchOptions): Promise<SearchHit[]> {
  return (await import('./search')).searchSite(query, options)
}

// In an island, the hits of `searchSite` for `query` as it changes: only the latest query's are shown, whichever answers first.
export function searchResults(query: () => string, options?: SearchOptions): SearchResults {
  const [hits, setHits] = ownSignal<SearchHit[]>([])
  const [loading, setLoading] = ownSignal(false)
  const [error, setError] = ownSignal<Error | undefined>(undefined)
  let asked = 0

  const ask = async (text: string, turn: number) => {
    try {
      const found = text.trim() === '' ? [] : await searchSite(text, options)

      if (turn === asked) {
        setHits(found)
        setError(undefined)
      }
    }
    catch (caught) {
      if (turn === asked) {
        setHits([])
        setError(caught instanceof Error ? caught : new Error(String(caught)))
      }
    }
    finally {
      if (turn === asked)
        setLoading(false)
    }
  }

  effect(() => {
    const text = query()

    setLoading(true)
    void ask(text, ++asked)
  })

  return { hits, loading, error }
}
