import { wording } from 'kay/words'
import { announce } from '../announce'
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

const CONTROLS = 'button,input,select,textarea,[role="button"]'

// The item's text without that of the controls it holds, which name themselves (`Milk` for `Milk` and a `Delete` button).
function ownText(item: HTMLElement): string | null {
  const copy = item.cloneNode(true) as HTMLElement

  for (const control of copy.querySelectorAll(CONTROLS))
    control.remove()

  return copy.textContent
}

// What the item holds, in a few words: its own label, else the alt of its first image, else its text.
function itemName(item: HTMLElement | undefined): string {
  if (!item)
    return ''

  const candidates = [item.getAttribute('aria-label'), item.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt'), ownText(item)]
  const text = (candidates.find(candidate => candidate !== null && candidate !== undefined && candidate.trim() !== '') ?? '').replaceAll(/\s+/g, ' ').trim()

  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

// Handles named here rather than by the page, which are named again once their item registers.
const named = new WeakSet<HTMLElement>()
// Watches the item of each, so the name follows its text.
const watchers = new WeakMap<HTMLElement, { watcher: MutationObserver, item: HTMLElement }>()

function nameHandle(el: HTMLElement, item?: HTMLElement): void {
  if (!el.matches('[role],a,button,input,summary'))
    el.setAttribute('role', 'button')

  const own = named.has(el)
  const given = el.matches('[aria-label],[aria-labelledby]') && !own

  if (given || el.textContent?.trim() || el.querySelector('img[alt]:not([alt=""])'))
    return

  const what = itemName(item)

  el.setAttribute('aria-label', what === '' ? wording('ui.dnd.handleLabel', 'Reorder') : wording('ui.dnd.handleItemLabel', 'Reorder {item}', { item: what }))
  named.add(el)

  if (!item || watchers.get(el)?.item === item)
    return

  watchers.get(el)?.watcher.disconnect()

  const watcher = new MutationObserver(() => nameHandle(el, item))

  watcher.observe(item, { childList: true, characterData: true, subtree: true })
  watchers.set(el, { watcher, item })
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

    const handle = this.#handles.get(id)

    // The handle was registered first, so it was named without its item.
    if (handle && named.has(handle))
      nameHandle(handle, el)
  }

  handle = (id: Id) => (el: HTMLElement): void => {
    this.#handles.set(id, el)
    // Tells assistive technology what the keyboard can do with the handle, and gives one the page left bare a role and a name.
    el.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown')
    nameHandle(el, this.#items.get(id))
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
      void this.#move(id, from, to, entries.length)
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
      void this.#move(drag.id, drag.from, drag.to)
  }

  // `kept` is the list's length for a move by key, which is announced and refocused, and left out for a drop, whose result the pointer shows.
  async #move(id: Id, from: number, to: number, kept?: number): Promise<void> {
    this.#moving = true

    try {
      await this.#onReorder(from, to)
    }
    finally {
      this.#moving = false
    }

    if (kept === undefined)
      return

    announce(wording('ui.dnd.moved', 'Moved to {position} of {count}', { position: to + 1, count: kept }), this.#handles.get(id))

    // A keyed list can drop focus while it moves the item's node, so focus goes back to the handle now on the page, which the list's effects have already drawn.
    const handle = this.#handles.get(id)

    if (handle && (!document.activeElement || document.activeElement === document.body))
      handle.focus()
  }
}
