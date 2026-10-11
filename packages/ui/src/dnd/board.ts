import type { Bar, Box, Point } from './geometry'
import { signal } from 'kay'
import { boardKeyTarget, edgeScroll, insertionBar, nearestBox, readingIndex } from './geometry'
import { armPointerDrag, boundsOf, ghostOf, on, scrollerOf, swallowClick } from './pointer'

type Id = number | string

// A move of `item` from container `from` into container `to`, at `index` among the items already there, the moved one left out.
export interface BoardMove {
  item: Id
  from: Id
  to: Id
  index: number
}

export interface BoardOptions {
  // Applies a move, by a drop or an arrow key. The board takes no other move until a returned promise settles, and a rejection goes unhandled, so wrap the call in `attempt`.
  onMove: (move: BoardMove) => void | Promise<void>
}

// Where a dragged item would land, and the insertion bar marking it, in viewport coordinates for a `position: fixed` element.
export interface BoardDrop {
  container: Id
  index: number
  bar: Bar
}

interface Drag {
  id: Id
  from: Id
  el: HTMLElement
  ghost: HTMLElement
  origin: Point
  pointer: Point
  scroller: HTMLElement | null
  frame: number
}

function byDocumentOrder(a: HTMLElement, b: HTMLElement): number {
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
}

// Moves items between containers and within them, for layouts that wrap such as a tier list or a kanban: `ref={board.container(id)}` marks each drop area and `ref={board.item(id, container)}` each entry, the whole of which is what a pointer grabs.
// A mouse or pen drags after a short move and a touch after a short hold, so a swipe still scrolls, and a ghost follows the pointer while `drop` names the landing slot; the containers change once `onMove` has updated them.
// On a focused item, ArrowLeft and ArrowRight move it within its container and ArrowUp and ArrowDown into the one before or after.
export class Board {
  // The item a pointer is dragging, for the page to dim or describe: `board.dragging()`.
  readonly dragging = signal<Id | null>(null)
  // Where the dragged item would land: `board.drop()`.
  readonly drop = signal<BoardDrop | null>(null)

  #containers = new Map<Id, HTMLElement>()
  #items = new Map<Id, { el: HTMLElement, container: Id }>()
  #drag: Drag | null = null
  #moving = false
  #onMove: BoardOptions['onMove']

  constructor(options: BoardOptions) {
    this.#onMove = options.onMove
  }

  // An element the page no longer renders is left out wherever the layout is read, rather than unregistered.
  container = (id: Id) => (el: HTMLElement): void => {
    this.#containers.set(id, el)
  }

  item = (id: Id, container: Id) => (el: HTMLElement): void => {
    this.#items.set(id, { el, container })
    el.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown')
    on(el, 'pointerdown', event => this.#arm(id, event))
    on(el, 'keydown', event => this.#step(id, event))
  }

  // The containers still on the page in page order, each with its items in page order.
  #layout(): { id: Id, el: HTMLElement, items: { id: Id, el: HTMLElement }[] }[] {
    const containers = [...this.#containers.entries()].filter(([, el]) => el.isConnected).sort(([, a], [, b]) => byDocumentOrder(a, b))

    return containers.map(([id, el]) => ({
      id,
      el,
      items: [...this.#items.entries()]
        .filter(([, item]) => item.container === id && item.el.isConnected)
        .map(([itemId, item]) => ({ id: itemId, el: item.el }))
        .sort((a, b) => byDocumentOrder(a.el, b.el)),
    }))
  }

  #arm(id: Id, event: PointerEvent): void {
    if (event.button !== 0 || this.#drag || this.#moving)
      return

    armPointerDrag(event, {
      start: origin => this.#start(id, origin),
      dragging: () => this.#drag !== null,
      move: (pointer) => {
        if (!this.#drag)
          return

        this.#drag.pointer = pointer
        this.#follow(this.#drag)
      },
      end: drop => this.#end(drop),
    })
  }

  #start(id: Id, origin: Point): void {
    const item = this.#items.get(id)

    if (!item || this.#drag || this.#moving)
      return

    const ghost = ghostOf(item.el)

    item.el.style.opacity = '0.3'

    this.#drag = { id, from: item.container, el: item.el, ghost, origin, pointer: origin, scroller: scrollerOf(item.el), frame: 0 }
    this.dragging.set(id)
    this.#follow(this.#drag)
    this.#tick()
  }

  // Moves the ghost under the pointer and finds the slot beneath it, from where the items stand right now.
  #follow(drag: Drag): void {
    drag.ghost.style.transform = `translate(${drag.pointer.x - drag.origin.x}px, ${drag.pointer.y - drag.origin.y}px)`

    const containers = this.#layout()
    const boxes: Box[] = containers.map(({ el }) => el.getBoundingClientRect())
    const index = nearestBox(drag.pointer, boxes)
    const container = containers[index]
    const box = boxes[index]

    if (!container || !box) {
      this.drop.set(null)

      return
    }

    const others = container.items.filter(item => item.id !== drag.id).map(({ el }) => el.getBoundingClientRect())
    const slot = readingIndex(others, drag.pointer)

    this.drop.set({ container: container.id, index: slot, bar: insertionBar(box, others, slot) })
  }

  #tick = (): void => {
    const drag = this.#drag

    if (!drag)
      return

    if (drag.scroller) {
      const step = edgeScroll(drag.pointer.y, boundsOf(drag.scroller))

      if (step) {
        drag.scroller.scrollTop += step
        this.#follow(drag)
      }
    }

    drag.frame = requestAnimationFrame(this.#tick)
  }

  #end(drop: boolean): void {
    const drag = this.#drag
    const target = this.drop()

    if (!drag)
      return

    this.#drag = null
    this.dragging.set(null)
    this.drop.set(null)
    cancelAnimationFrame(drag.frame)
    drag.ghost.remove()
    drag.el.style.opacity = ''

    swallowClick()

    if (!drop || !target)
      return

    const from = this.#layout().find(container => container.id === drag.from)
    const fromIndex = from?.items.findIndex(item => item.id === drag.id) ?? -1

    if (target.container !== drag.from || target.index !== fromIndex)
      void this.#move({ item: drag.id, from: drag.from, to: target.container, index: target.index }, false)
  }

  #step(id: Id, event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target !== this.#items.get(id)?.el)
      return

    const containers = this.#layout()
    const from = containers.findIndex(container => container.items.some(item => item.id === id))
    const index = containers[from]?.items.findIndex(item => item.id === id) ?? -1
    const target = boardKeyTarget(event.key, from, index, containers.map(container => container.items.length))

    if (from === -1 || !target)
      return

    event.preventDefault()

    const to = containers[target.container]

    if (to && (target.container !== from || target.index !== index) && !this.#drag && !this.#moving)
      void this.#move({ item: id, from: containers[from]!.id, to: to.id, index: target.index }, true)
  }

  async #move(move: BoardMove, refocus: boolean): Promise<void> {
    this.#moving = true

    try {
      await this.#onMove(move)
    }
    finally {
      this.#moving = false
    }

    if (!refocus)
      return

    // A keyed list moving the item into another container remounts it, so focus goes to its new node, drawn by the time this continuation runs, as `Sortable` does for its handles.
    const item = this.#items.get(move.item)

    if (item && (!document.activeElement || document.activeElement === document.body))
      item.el.focus()
  }
}
