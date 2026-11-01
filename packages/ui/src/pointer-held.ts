// Whether a pointer button is down, kept for the whole page once `trackPointer` ran.
let held = false
let tracking = false

// Starts following the pointer buttons, from the page's first Popover on, so a press that opened one is known to still be down.
export function trackPointer(): void {
  if (tracking || typeof document === 'undefined')
    return

  tracking = true

  for (const type of ['pointerdown', 'pointerup', 'pointercancel'])
    document.addEventListener(type, (event) => { held = (event as PointerEvent).buttons !== 0 }, true)
}

// Runs `show` now, or one frame after the button down is released: Linux browsers fire `contextmenu` on the press, and a popover shown before the release reads it as a click outside and hides.
export function whenReleased(show: () => void): void {
  if (!held) {
    show()

    return
  }

  const release = () => {
    document.removeEventListener('pointerup', release, true)
    document.removeEventListener('pointercancel', release, true)
    requestAnimationFrame(show)
  }

  document.addEventListener('pointerup', release, true)
  document.addEventListener('pointercancel', release, true)
}
