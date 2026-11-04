import { requestIsland } from './island-request'

// A deferred server island fetched again for this visitor, its old content ended by `dispose` just before the new goes in; a failed request throws and leaves the island as it was, and the control that had the focus gets it back in the new content.
// Kept apart from `fetchServerIsland`, which every page with a server island loads, as only a page following a value needs this; the request itself is shared (`requestIsland`).
export async function refetchServerIsland(slot: HTMLElement, dispose: () => void): Promise<() => void> {
  const held = document.activeElement instanceof HTMLElement && slot.contains(document.activeElement) ? document.activeElement : undefined
  const id = held?.id ?? ''
  const name = held?.getAttribute('name') ?? ''
  const text = await requestIsland(slot)

  if (text === undefined)
    return () => undefined

  dispose()
  slot.innerHTML = text

  return () => {
    if (held === undefined || (document.activeElement !== null && document.activeElement !== document.body))
      return

    const again = (id === '' ? null : slot.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`)) ?? (name === '' ? null : slot.querySelector<HTMLElement>(`${held.tagName}[name="${CSS.escape(name)}"]`))

    again?.focus({ preventScroll: true })
  }
}
