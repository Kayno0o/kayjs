import type { Point } from './geometry'
import { signal } from 'kay'
import { edgeScroll } from './geometry'
import { armPointerDrag, boundsOf, ghostOf, on, scrollerOf, swallowClick } from './pointer'

// How long the pointer rests on a target before `onLinger` runs for it.
const LINGER_MS = 600

type Id = number | string

export interface DropTargetsOptions<Item extends Id, Target extends Id> {
  // Whether `item` may land on `target`; a target refusing it is neither marked nor dropped on.
  accepts?: (item: Item, target: Target) => boolean
  // Applies a drop. No other drag starts until a returned promise settles, and a rejection goes unhandled, so wrap the call in `attempt`.
  onDrop: (item: Item, target: Target) => void | Promise<void>
  // Runs once the pointer has rested on an accepting target for a moment, such as to open a collapsed folder under it.
  onLinger?: (target: Target) => void
}

interface Drag<Item> {
  id: Item
  el: HTMLElement
  ghost: HTMLElement
  origin: Point
  pointer: Point
  scroller: HTMLElement | null
  frame: number
  linger: ReturnType<typeof setTimeout> | undefined
}

// Drags items onto targets, for a move that is not a reorder, such as a note into a folder of a tree: `ref={targets.item(id)}` marks what a pointer grabs, whole, and `ref={targets.target(id)}` each place it can land.
// The innermost target under the pointer wins, so a row inside a folder's element can stand for that folder or for its own. A mouse or pen drags after a short move and a touch after a short hold; a ghost follows the pointer while `over` names the target it would land on.
// Pointers only: the keyboard has no spatial way to reach a target, so give it a menu or a dialog for the same move.
export class DropTargets<Item extends Id = Id, Target extends Id = Id> {
  // The item a pointer is dragging, for the page to dim: `targets.dragging()`.
  readonly dragging = signal<Item | null>(null)
  // The accepting target the dragged item would land on: `targets.over()`.
  readonly over = signal<Target | null>(null)

  #items = new Map<Item, HTMLElement>()
  #targets = new WeakMap<Element, Target>()
  #drag: Drag<Item> | null = null
  #dropping = false
  #options: DropTargetsOptions<Item, Target>

  constructor(options: DropTargetsOptions<Item, Target>) {
    this.#options = options
  }

  item = (id: Item) => (el: HTMLElement): void => {
    this.#items.set(id, el)
    on(el, 'pointerdown', event => this.#arm(id, event))
  }

  // Held weakly, so a target the page no longer renders goes with its element.
  target = (id: Target) => (el: HTMLElement): void => {
    this.#targets.set(el, id)
  }

  #arm(id: Item, event: PointerEvent): void {
    if (event.button !== 0 || this.#drag || this.#dropping)
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

  #start(id: Item, origin: Point): void {
    const el = this.#items.get(id)

    if (!el?.isConnected || this.#drag || this.#dropping)
      return

    const ghost = ghostOf(el)

    el.style.opacity = '0.4'

    this.#drag = { id, el, ghost, origin, pointer: origin, scroller: scrollerOf(el), frame: 0, linger: undefined }
    this.dragging.set(id)
    this.#follow(this.#drag)
    this.#tick()
  }

  // The innermost accepting target under the pointer, read off the page as it stands now.
  #targetAt(drag: Drag<Item>): Target | null {
    for (let node = document.elementFromPoint(drag.pointer.x, drag.pointer.y); node; node = node.parentElement) {
      const target = this.#targets.get(node)

      if (target !== undefined)
        return this.#options.accepts?.(drag.id, target) === false ? null : target
    }

    return null
  }

  #follow(drag: Drag<Item>): void {
    drag.ghost.style.transform = `translate(${drag.pointer.x - drag.origin.x}px, ${drag.pointer.y - drag.origin.y}px)`

    const target = this.#targetAt(drag)

    if (target === this.over())
      return

    this.over.set(target)
    clearTimeout(drag.linger)

    const { onLinger } = this.#options

    if (target !== null && onLinger) {
      drag.linger = setTimeout(() => {
        if (this.#drag === drag && this.over() === target)
          onLinger(target)
      }, LINGER_MS)
    }
  }

  #tick = (): void => {
    const drag = this.#drag

    if (!drag)
      return

    if (drag.scroller) {
      const step = edgeScroll(drag.pointer.y, boundsOf(drag.scroller))

      if (step)
        drag.scroller.scrollTop += step
    }

    // Every frame, since a scroll or a folder opening under a still pointer changes what it points at.
    this.#follow(drag)
    drag.frame = requestAnimationFrame(this.#tick)
  }

  #end(drop: boolean): void {
    const drag = this.#drag
    const target = this.over()

    if (!drag)
      return

    this.#drag = null
    this.dragging.set(null)
    this.over.set(null)
    cancelAnimationFrame(drag.frame)
    clearTimeout(drag.linger)
    drag.ghost.remove()
    drag.el.style.opacity = ''

    swallowClick()

    if (drop && target !== null)
      void this.#drop(drag.id, target)
  }

  async #drop(item: Item, target: Target): Promise<void> {
    this.#dropping = true

    try {
      await this.#options.onDrop(item, target)
    }
    finally {
      this.#dropping = false
    }
  }
}
