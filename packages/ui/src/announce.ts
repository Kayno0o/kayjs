// Says `message` to a screen reader through a polite live region, made on first use and kept off screen.
// It lives in the open modal dialog holding `from` (the focused element by default), since a modal makes the rest of the page inert, and in the page otherwise.
export function announce(message: string, from: Element | null = document.activeElement): void {
  const host = from?.closest('dialog') ?? document.body
  let region = host.querySelector<HTMLElement>(':scope > [data-kui-announce]')

  if (!region) {
    region = host.appendChild(document.createElement('div'))
    region.setAttribute('data-kui-announce', '')
    region.setAttribute('aria-live', 'polite')
    region.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'

    // A region put in the page and filled at once is often not read, so the first words wait for it to have been there.
    const fresh = region

    // A call meanwhile has already written its newer words.
    setTimeout(() => fresh.textContent ||= message, 100)

    return
  }

  // The same words twice in a row are not read again unless the text changed.
  region.textContent = region.textContent === message ? `${message}\u00A0` : message
}
