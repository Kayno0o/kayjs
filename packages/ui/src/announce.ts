const SELECTOR = '[data-kui-announce]'

// Says `message` to a screen reader through one polite live region the page shares, made on first use and kept off screen.
// The region is looked up in the page rather than held in a variable, so every copy of this module a bundle carries finds the same one.
export function announce(message: string): void {
  if (typeof document === 'undefined')
    return

  let region = document.querySelector<HTMLElement>(SELECTOR)

  if (!region) {
    region = document.createElement('div')
    region.setAttribute('data-kui-announce', '')
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    Object.assign(region.style, { position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: '0' })
    document.body.append(region)
  }

  // The same words twice in a row are not read again unless the text changed.
  region.textContent = region.textContent === message ? `${message}\u00A0` : message
}
