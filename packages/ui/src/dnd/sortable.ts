import { edgeScroll, keyTarget, offsetOf, targetIndex } from './geometry'
import { armPointerDrag, boundsOf, on, scrollerOf, swallowClick } from './pointer'

type Id = number | string

interface Drag {
  id: Id
  el: HTMLElement
  from: number
  to: number
  // Every item in list order, with its vertical middle where it sat when the drag began.
  items: { el: HTMLElement, mid: number }[]
  // How far a passed item moves out of the way: the dragged item's height plus the list's gap.
  shift: number
  originY: number
  pointerY: number
  scroller: HTMLElement | null
  // Where the scroller stood when the drag began.
  scrollTop: number
  // Where it stood at the last layout, so a scroll the pointer did not cause still moves the items.
  laidOutScrollTop: number
  frame: number
}

export interface SortableOptions {
  // A move of the item at index `from` of the list to index `to`, by a drop or an arrow key. The list takes no other move until a returned promise settles, and a rejection goes unhandled, so wrap the call in `attempt`.
  onReorder: (from: number, to: number) => void | Promise<void>
}

function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

// Reordering for a vertical list, by mouse, touch, pen or keyboard: `ref={sortable.item(id)}` marks each entry and `ref={sortable.handle(id)}` the part a pointer grabs, which needs `touch-none` or the browser pans the page instead.
// ArrowUp and ArrowDown on a focused handle move its item one place; a drag only slides the items out of the way, and the list itself changes once `onReorder` has updated it.
export class Sortable {
  #items = new Map<Id, HTMLElement>()
  #handles = new Map<Id, HTMLElement>()
  #drag: Drag | null = null
  // Set while a move's `onReorder` runs, so a second move never starts from the order the first is still writing.
  #moving = false
  #onReorder: SortableOptions['onReorder']

  constructor(options: SortableOptions) {
    this.#onReorder = options.onReorder
  }

  // An element a list no longer renders is left out wherever the items are read, rather than unregistered.
  item = (id: Id) => (el: HTMLElement): void => {
    this.#items.set(id, el)
  }

  handle = (id: Id) => (el: HTMLElement): void => {
    this.#handles.set(id, el)
    // Tells assistive technology what the keyboard can do with the handle.
    el.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown')
    on(el, 'pointerdown', event => this.#arm(id, event))
    on(el, 'keydown', event => this.#step(id, event))
  }

  // The registered items still on the page, in the order it shows them.
  #ordered(): HTMLElement[] {
    return [...this.#items.values()].filter(el => el.isConnected).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  }

  #arm(id: Id, event: PointerEvent): void {
    if (event.button !== 0 || this.#drag || this.#moving)
      return

    // The items slide under a pointer that would otherwise select their text.
    const stopSelecting = on(document, 'selectionchange', () => {
      if (this.#drag)
        clearSelection()
    })

    armPointerDrag(event, {
      start: origin => this.#start(id, origin.y),
      dragging: () => this.#drag !== null,
      move: (pointer) => {
        if (!this.#drag)
          return

        this.#drag.pointerY = pointer.y
        this.#layout(this.#drag)
      },
      end: (drop) => {
        stopSelecting()
        this.#end(drop)
      },
    })
  }

  #step(id: Id, event: KeyboardEvent): void {
    const el = this.#items.get(id)

    if (!el?.isConnected || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return

    const entries = this.#ordered()
    const from = entries.indexOf(el)
    const to = keyTarget(event.key, from, entries.length)

    if (to === null)
      return

    // An arrow key on a handle moves its item and never the page, even at either end of the list.
    event.preventDefault()

    if (to !== from && !this.#drag && !this.#moving)
      void this.#move(id, from, to, true)
  }

  #start(id: Id, originY: number): void {
    const el = this.#items.get(id)

    // An arrow key can start a move during a touch's hold, and a drag begun after it would drop onto the order that move is still writing.
    if (!el || this.#drag || this.#moving)
      return

    const entries = this.#ordered()
    const items = entries.map((item) => {
      const rect = item.getBoundingClientRect()

      return { el: item, mid: rect.top + rect.height / 2 }
    })
    const gap = el.parentElement ? Number.parseFloat(getComputedStyle(el.parentElement).rowGap) || 0 : 0
    const scroller = scrollerOf(el)
    const from = entries.indexOf(el)
    const scrollTop = scroller?.scrollTop ?? 0

    this.#drag = {
      id,
      el,
      from,
      to: from,
      items,
      shift: el.getBoundingClientRect().height + gap,
      originY,
      pointerY: originY,
      scroller,
      scrollTop,
      laidOutScrollTop: scrollTop,
      frame: 0,
    }

    Object.assign(el.style, { position: 'relative', zIndex: '10', opacity: '0.9', pointerEvents: 'none' })

    for (const item of items) {
      if (item.el !== el)
        item.el.style.transition = 'transform 150ms'
    }

    clearSelection()
    this.#tick()
  }

  #layout(drag: Drag): void {
    const scrollTop = drag.scroller?.scrollTop ?? 0
    // Where the pointer falls among the other items, measured against where they sat before the drag.
    const y = drag.pointerY + scrollTop - drag.scrollTop

    drag.laidOutScrollTop = scrollTop
    drag.el.style.transform = `translateY(${y - drag.originY}px)`
    drag.to = targetIndex(drag.items, drag.from, y)

    for (const [index, item] of drag.items.entries()) {
      if (index === drag.from)
        continue

      const offset = offsetOf(index, drag.from, drag.to, drag.shift)

      item.el.style.transform = offset ? `translateY(${offset}px)` : ''
    }
  }

  #tick = (): void => {
    const drag = this.#drag

    if (!drag)
      return

    if (drag.scroller) {
      const step = edgeScroll(drag.pointerY, boundsOf(drag.scroller))

      if (step)
        drag.scroller.scrollTop += step

      // A wheel or keyboard scroll moves the list under a still pointer just as the edge scroll does.
      if (drag.scroller.scrollTop !== drag.laidOutScrollTop)
        this.#layout(drag)
    }

    drag.frame = requestAnimationFrame(this.#tick)
  }

  #end(drop: boolean): void {
    const drag = this.#drag

    if (!drag)
      return

    this.#drag = null
    cancelAnimationFrame(drag.frame)

    for (const { el } of drag.items)
      Object.assign(el.style, { transition: '', transform: '' })

    Object.assign(drag.el.style, { position: '', zIndex: '', opacity: '', pointerEvents: '' })
    swallowClick()

    if (drop && drag.to !== drag.from)
      void this.#move(drag.id, drag.from, drag.to, false)
  }

  async #move(id: Id, from: number, to: number, refocus: boolean): Promise<void> {
    this.#moving = true

    try {
      await this.#onReorder(from, to)
    }
    finally {
      this.#moving = false
    }

    if (!refocus)
      return

    // A keyed list can drop focus while it moves the item's node, so focus goes back to the handle now on the page, which the list's effects have already drawn.
    const handle = this.#handles.get(id)

    if (handle && (!document.activeElement || document.activeElement === document.body))
      handle.focus()
  }
}
