// The polite live region a swap announces itself in, shared by `spa()` and `regions()`.

export const ANNOUNCER_ID = '__kay-spa-announcer'

function applySrOnlyStyle(el: HTMLElement): void {
  const s = el.style
  s.position = 'absolute'
  s.width = '1px'
  s.height = '1px'
  s.padding = '0'
  s.margin = '-1px'
  s.overflow = 'hidden'
  s.clip = 'rect(0,0,0,0)'
  s.whiteSpace = 'nowrap'
  s.border = '0'
}

export function announce(text: string): void {
  let region = document.getElementById(ANNOUNCER_ID)
  if (region === null) {
    region = document.createElement('div')
    region.id = ANNOUNCER_ID
    region.setAttribute('role', 'status')
    region.setAttribute('aria-live', 'polite')
    region.setAttribute('aria-atomic', 'true')
    applySrOnlyStyle(region)
    document.body.appendChild(region)
  }
  region.textContent = text
}
