import type { Point } from './geometry'

// Adds a listener and hands back what removes it.
export function on<K extends keyof DocumentEventMap>(target: Document, type: K, listener: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions): () => void
export function on<K extends keyof WindowEventMap>(target: Window, type: K, listener: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): () => void
export function on<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): () => void
export function on(target: EventTarget, type: string, listener: (event: never) => void, options?: AddEventListenerOptions): () => void {
  target.addEventListener(type, listener as EventListener, options)

  return () => target.removeEventListener(type, listener as EventListener, options)
}

// A touch starts a drag by holding this long without moving, so a swipe still scrolls the page.
export const ACTIVATION_DELAY_MS = 250
// Move a mouse or pen this far first and the drag starts at once.
export const ACTIVATION_DISTANCE_PX = 10

// The nearest ancestor that scrolls vertically, or the page when it does, for edge scrolling during a drag.
export function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)

    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1)
      return node
  }

  // With no scrolling ancestor, the page itself is what scrolls, if anything does.
  const page = document.scrollingElement

  return page instanceof HTMLElement && page.scrollHeight > page.clientHeight + 1 ? page : null
}

// The stretch of the viewport a scroller shows: all of it for the page, its own box for anything else.
export function boundsOf(scroller: HTMLElement): { top: number, bottom: number } {
  return scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect()
}

// A copy of `el` fixed over it, appended to the body, for a drag to move under the pointer.
export function ghostOf(el: HTMLElement): HTMLElement {
  const rect = el.getBoundingClientRect()
  const ghost = el.cloneNode(true) as HTMLElement

  ghost.removeAttribute('id')
  ghost.setAttribute('aria-hidden', 'true')
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    zIndex: '1000',
    pointerEvents: 'none',
    opacity: '0.9',
  })
  document.body.append(ghost)
  window.getSelection()?.removeAllRanges()

  return ghost
}

// Swallows the click the browser sends after the pointerup that ended a drag, which must not open the item the drag started from.
export function swallowClick(): void {
  const stop = on(window, 'click', (click) => {
    click.preventDefault()
    click.stopPropagation()
  }, { capture: true })

  setTimeout(stop)
}

export interface PointerDragHandlers {
  // Starts the drag from where the pointer went down; a no-op when it cannot start.
  start: (origin: Point) => void
  // Whether a drag is under way.
  dragging: () => boolean
  // The pointer moved during the drag.
  move: (pointer: Point) => void
  // The drag ended, dropping or cancelled.
  end: (drop: boolean) => void
}

// Follows a pointer that went down on a draggable item until it comes up: a mouse or pen starts the drag after a short move, a touch after a short hold, and Escape or a cancelled pointer ends it without a drop.
// Only a touch starts on a hold, since a mouse held still is a slow click that must still reach the item, and a touch moving before its hold is over is a scroll the browser takes.
export function armPointerDrag(event: PointerEvent, handlers: PointerDragHandlers): void {
  const origin = { x: event.clientX, y: event.clientY }
  const touch = event.pointerType === 'touch'
  const timer = touch ? setTimeout(() => handlers.start(origin), ACTIVATION_DELAY_MS) : undefined

  const stops = [
    on(document, 'pointermove', (move) => {
      const moved = Math.hypot(move.clientX - origin.x, move.clientY - origin.y) > ACTIVATION_DISTANCE_PX

      if (!handlers.dragging() && moved) {
        if (touch) {
          disarm()

          return
        }

        handlers.start(origin)
      }

      if (handlers.dragging())
        handlers.move({ x: move.clientX, y: move.clientY })
    }),
    // Registered as not passive, so a touch drag keeps the page from panning under it once it has started.
    on(document, 'touchmove', (move) => {
      if (handlers.dragging())
        move.preventDefault()
    }, { passive: false }),
    on(document, 'contextmenu', menu => menu.preventDefault()),
    // A link or an image is natively draggable, and the browser taking the drag over cancels the pointer this one follows.
    on(document, 'dragstart', native => native.preventDefault()),
    on(document, 'keydown', (key) => {
      if (key.key === 'Escape' && handlers.dragging()) {
        key.preventDefault()
        disarm()
        handlers.end(false)
      }
    }),
    on(document, 'pointerup', () => {
      disarm()
      handlers.end(true)
    }),
    on(document, 'pointercancel', () => {
      disarm()
      handlers.end(false)
    }),
  ]

  function disarm(): void {
    clearTimeout(timer)

    for (const stop of stops)
      stop()
  }
}
