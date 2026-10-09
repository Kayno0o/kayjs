import { ISLAND_HEADER, ISLAND_PARAM } from './server-islands'

// A deferred server island rendered for this visitor in place of the inert copy standing in for it.
export async function fetchServerIsland(element: HTMLElement): Promise<void> {
  const url = new URL(location.href)

  url.searchParams.set(ISLAND_PARAM, element.dataset.kayServer ?? '')
  url.hash = ''

  const response = await fetch(url, { headers: { [ISLAND_HEADER]: '1' } })

  if (!response.ok)
    throw new Error(`kay: the server island ${element.dataset.kayServer} of ${location.pathname} answered ${response.status}`)

  element.innerHTML = await response.text()
  element.removeAttribute('inert')
}
