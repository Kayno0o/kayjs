// Pinned to the top corner: left where it falls, after the page, it would add a pixel to a layout filling the screen and give it a scrollbar.
const OFFSCREEN = 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)'
const FIRST_WRITE_DELAY = 100
const NBSP = ' '

// Says `text` to a screen reader through a polite live region, made on first use and kept off screen.
// It lives in the open modal dialog holding `within` (the focused element by default), since a modal makes the rest of the page inert, and in the page otherwise, outside any form whose `aria-busy` may hold back what changes inside it.
// kept: free
export function announce(text: string, within: Element | null = document.activeElement): void {
  const host = within?.closest('dialog') ?? document.body
  let region = host.querySelector<HTMLElement>(':scope > [data-kay-announce]')

  if (!region) {
    region = host.appendChild(document.createElement('div'))
    // `data-kui-announce` is the name kayjs-ui's region went by, which a page or a test of an app may still select.
    region.setAttribute('data-kay-announce', '')
    region.setAttribute('data-kui-announce', '')
    // A page swap leaves the body's where it is, so words said just before one are still read; a dialog goes with the swap anyway.
    region.setAttribute('data-kay-keep', '')
    region.setAttribute('aria-live', 'polite')
    region.style.cssText = OFFSCREEN

    // A region put in the page and filled at once is often not read, so the first words wait for it to have been there.
    const fresh = region

    // A call meanwhile has already written its newer words.
    setTimeout(() => fresh.textContent ||= text, FIRST_WRITE_DELAY)

    return
  }

  // The same words twice in a row are not read again unless the text changed.
  region.textContent = region.textContent === text ? text + NBSP : text
}
