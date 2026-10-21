import { skew } from './build'
import { ISLAND_HEADER, ISLAND_PARAM } from './server-islands'

export interface FetchedIsland extends HTMLElement {
  // The inert copy the island replaced, which a page swap compares the next page's copy with.
  _$b?: string
}

// A deferred server island rendered for this visitor in place of the inert copy standing in for it.
// One a page swap held, showing the last render, gets its inert copy back when the fetch fails.
export async function fetchServerIsland(element: FetchedIsland): Promise<void> {
  const url = new URL(location.href)
  const held = element._$b

  url.searchParams.set(ISLAND_PARAM, element.dataset.kayServer ?? '')
  url.hash = ''

  try {
    const response = await fetch(url, { headers: { [ISLAND_HEADER]: '1' } })

    if (await skew(response))
      return

    if (!response.ok)
      throw new Error(`kay: the server island ${element.dataset.kayServer} of ${location.pathname} answered ${response.status}`)

    element._$b ??= element.innerHTML
    element.innerHTML = await response.text()
    element.removeAttribute('inert')
  }
  catch (error) {
    if (held !== undefined)
      element.innerHTML = held

    throw error
  }
}
