const SELECTOR = ':scope > [data-kui-announce]'
// A region put in the page and filled at once is often not read, so the first words wait for it to have been there.
const SETTLE_MS = 100

// Says `message` to a screen reader through a polite live region, made on first use and kept off screen.
// It lives in the open modal dialog holding `from` (the focused element by default), since a modal makes the rest of the page inert, and in the page otherwise. It is looked up in the page rather than held in a variable, so every copy of this module a bundle carries finds the same one.
export function announce(message: string, from: Element | null = typeof document === 'undefined' ? null : document.activeElement): void {
  if (typeof document === 'undefined')
    return

  const host = from?.closest('dialog') ?? document.body
  let region = host.querySelector<HTMLElement>(SELECTOR)

  if (!region) {
    region = document.createElement('div')
    region.setAttribute('data-kui-announce', '')
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    Object.assign(region.style, { position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: '0' })
    host.append(region)

    const fresh = region

    setTimeout(() => {
      fresh.textContent = message
    }, SETTLE_MS)

    return
  }

  // The same words twice in a row are not read again unless the text changed.
  region.textContent = region.textContent === message ? `${message}\u00A0` : message
}
