import { skew } from './build'
import { ISLAND_HEADER, ISLAND_PARAM } from './server-islands'

interface FetchedIsland extends HTMLElement {
  _$b?: string
}

// A deferred server island rendered for this visitor in place of the inert copy standing in for it.
export async function fetchServerIsland(element: HTMLElement): Promise<void> {
  const url = new URL(location.href)

  url.searchParams.set(ISLAND_PARAM, element.dataset.kayServer ?? '')
  url.hash = ''

  const response = await fetch(url, { headers: { [ISLAND_HEADER]: '1' } })

  if (await skew(response))
    return

  if (!response.ok) {
    throw new Error(`kay: the server island ${element.dataset.kayServer} of ${location.pathname} answered ${response.status}`)

    // Kept for a page swap, which holds the island while the next page's copy of it is fetched.
  }

  (element as FetchedIsland)._$b ??= element.innerHTML
  element.innerHTML = await response.text()
  element.removeAttribute('inert')
}
