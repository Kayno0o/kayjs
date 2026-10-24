import { skew } from './build'
import { ISLAND_HEADER, ISLAND_PARAM } from './server-islands'

export interface FetchedIsland extends HTMLElement {
  // The inert copy the island replaced, which a page swap compares the next page's copy with.
  _$b?: string
  // The control of a held island that had the focus when the page swap took it away, as inert content keeps none.
  _$f?: HTMLElement
}

// A deferred server island rendered for this visitor in place of the inert copy standing in for it.
// One a page swap held, showing the last render, gets its inert copy back when the fetch fails.
export async function fetchServerIsland(element: FetchedIsland): Promise<void> {
  const url = new URL(location.href)
  const held = element._$b
  // Taken before any exit, so a fetch that fails or meets a skew leaves no node referenced.
  const focused = focusIn(element)

  url.searchParams.set(ISLAND_PARAM, element.dataset.kayServer ?? '')
  url.hash = ''

  try {
    const response = await fetch(url, { headers: { [ISLAND_HEADER]: '1' } })

    if (await skew(response))
      return

    if (!response.ok)
      throw new Error(`kay: the server island ${element.dataset.kayServer} of ${location.pathname} answered ${response.status}`)

    const text = await response.text()

    element._$b ??= element.innerHTML
    element.innerHTML = text
    element.removeAttribute('inert')
    focused?.()
  }
  catch (error) {
    if (held !== undefined)
      element.innerHTML = held

    throw error
  }
}

// The focus a page swap took from the island, which replacing its content cannot give back: the returned function gives it to the equivalent control of the new content, by id, else by name, else by place among the controls of its tag.
function focusIn(island: FetchedIsland): (() => void) | undefined {
  const held = island._$f

  delete island._$f

  if (!held?.isConnected || !island.contains(held))
    return undefined

  const { id, tagName } = held
  const name = held.getAttribute('name') ?? ''
  const place = [...island.querySelectorAll(tagName)].indexOf(held)

  return () => {
    // A visitor who focused something else meanwhile keeps it.
    if (document.activeElement !== null && document.activeElement !== document.body)
      return

    const same = [...island.querySelectorAll<HTMLElement>(tagName)]
    const again = (id === '' ? undefined : island.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)) ?? (name === '' ? undefined : same.find(element => element.getAttribute('name') === name)) ?? same[place]

    again?.focus({ preventScroll: true })
  }
}
