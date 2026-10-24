import { skew } from './build'
import { ISLAND_HEADER, ISLAND_PARAM } from './server-islands'

// A deferred server island fetched again for this visitor, its old content ended by `dispose` just before the new goes in; a failed fetch leaves the island as it was, and the control that had the focus gets it back in the new content.
// Kept apart from `fetchServerIsland`, which every page with a server island loads, as only a page following a value needs this.
export async function refetchServerIsland(slot: HTMLElement, dispose: () => void): Promise<() => void> {
  const url = new URL(location.href)
  const held = document.activeElement instanceof HTMLElement && slot.contains(document.activeElement) ? document.activeElement : undefined
  const id = held?.id ?? ''
  const name = held?.getAttribute('name') ?? ''

  url.searchParams.set(ISLAND_PARAM, slot.dataset.kayServer ?? '')
  url.hash = ''

  const response = await fetch(url, { headers: { [ISLAND_HEADER]: '1' } })

  if (await skew(response))
    return () => undefined

  if (!response.ok)
    throw new Error(`kay: the server island ${slot.dataset.kayServer} of ${location.pathname} answered ${response.status}`)

  const text = await response.text()

  dispose()
  slot.innerHTML = text

  return () => {
    if (held === undefined || (document.activeElement !== null && document.activeElement !== document.body))
      return

    const again = (id === '' ? null : slot.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)) ?? (name === '' ? null : slot.querySelector<HTMLElement>(`${held.tagName}[name="${CSS.escape(name)}"]`))

    again?.focus({ preventScroll: true })
  }
}
