import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mount, settle } from 'kay/test'
import { Board } from '../src/dnd/board'
import { DropTargets } from '../src/dnd/drop-targets'
import { ACTIVATION_DELAY_MS } from '../src/dnd/pointer'
import { Sortable } from '../src/dnd/sortable'

const MODIFIERS: KeyboardEventInit[] = [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]

let mounted: Mounted | undefined
let staged: HTMLElement[] = []

afterEach(async () => {
  mounted?.unmount()
  mounted = undefined

  for (const element of staged)
    element.remove()

  staged = []
  // A drag's release swallows the next click until a task later, which must not reach the next test.
  await settle()
})

function stage(): HTMLElement {
  const element = document.createElement('div')

  document.body.append(element)
  staged.push(element)

  return element
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })

  target.dispatchEvent(event)

  return event
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

  if (!found)
    throw new Error(`No button reads ${label}.`)

  return found
}

// Three entries with a handle each, wired to a Sortable that logs every move and answers it with `answer`, leaving the DOM as it was.
function listOf(answer: () => void | Promise<void> = () => undefined) {
  const moves: [from: number, to: number][] = []
  const sortable = new Sortable({
    onReorder: (from, to) => {
      moves.push([from, to])

      return answer()
    },
  })
  const list = stage()
  const handles: HTMLButtonElement[] = []

  for (const id of [1, 2, 3]) {
    const item = document.createElement('li')
    const handle = document.createElement('button')

    item.append(handle)
    list.append(item)
    sortable.item(id)(item)
    sortable.handle(id)(handle)
    handles.push(handle)
  }

  return { moves, handles }
}

describe('Sortable, from the keyboard', () => {
  test('moves a focused handle\'s item one place per arrow key, and names those keys for assistive technology', async () => {
    const { moves, handles: [, middle] } = listOf()

    press(middle!, 'ArrowDown')
    await Bun.sleep(0)
    press(middle!, 'ArrowUp')

    expect(moves).toEqual([[1, 2], [1, 0]])
    expect(middle!.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown')
  })

  test('starts each move from where the rows stand now, and keeps focus on the handle a keyed list moved', async () => {
    mounted = await mount('src/components/sortable-list.kay')

    const { root } = mounted
    const read = button(root, 'Read')

    read.focus()
    press(read, 'ArrowDown')
    // A microtask only, since a key pressed right after the move must already find focus back on its handle.
    await Promise.resolve()

    expect(document.activeElement === button(root, 'Read')).toBe(true)

    press(button(root, 'Read'), 'ArrowDown')
    await Promise.resolve()

    expect([...root.querySelectorAll('li')].map(item => item.textContent?.trim())).toEqual(['Run', 'Write', 'Read'])
    expect(document.activeElement === button(root, 'Read')).toBe(true)
  })

  test('holds an item at either end of the list, still keeping the key from scrolling the page', () => {
    const { moves, handles: [first, , last] } = listOf()

    expect(press(first!, 'ArrowUp').defaultPrevented).toBe(true)
    expect(press(last!, 'ArrowDown').defaultPrevented).toBe(true)
    expect(moves).toEqual([])
  })

  test('leaves other keys, and arrows held with any modifier, to the browser', () => {
    const { moves, handles: [, middle] } = listOf()

    expect(press(middle!, 'Enter').defaultPrevented).toBe(false)

    for (const modifier of MODIFIERS)
      expect(press(middle!, 'ArrowDown', modifier).defaultPrevented).toBe(false)

    expect(moves).toEqual([])
  })

  test('takes no other move until the one in flight settles', async () => {
    const saving = Promise.withResolvers<void>()
    const { moves, handles: [first, middle] } = listOf(async () => saving.promise)

    press(middle!, 'ArrowDown')
    press(first!, 'ArrowDown')

    expect(moves).toEqual([[1, 2]])

    saving.resolve()
    await Bun.sleep(0)
    press(first!, 'ArrowDown')

    expect(moves).toEqual([[1, 2], [0, 1]])
  })

  test('leaves focus alone when it went somewhere else in the meantime', async () => {
    const { handles: [first, middle] } = listOf(() => first!.focus())

    middle!.focus()
    press(middle!, 'ArrowDown')
    await Bun.sleep(0)

    expect(document.activeElement === first).toBe(true)
  })
})

// happy-dom lays nothing out, so each element is given the box a browser would have drawn.
function box(el: HTMLElement, left: number, top: number, width: number, height: number): void {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
}

function pointer(target: EventTarget, type: string, x: number, y: number, pointerType = 'mouse'): PointerEvent {
  const event = new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerType, bubbles: true, cancelable: true })

  target.dispatchEvent(event)

  return event
}

describe('Sortable, by pointer', () => {
  // The three entries stacked 40px apart, their handles at the left.
  function stacked() {
    const list = listOf()
    const items = list.handles.map(handle => handle.parentElement!)

    for (const [index, item] of items.entries())
      box(item, 0, index * 40, 100, 40)

    return { ...list, items }
  }

  test('drags a handle past its neighbours once it moved, sliding them aside, and reorders on release', () => {
    const { moves, handles: [first], items } = stacked()

    pointer(first!, 'pointerdown', 5, 20)
    pointer(document, 'pointermove', 5, 25)

    expect(items[0]!.style.position).toBe('')

    pointer(document, 'pointermove', 5, 105)

    expect([items[0]!.style.transform, items[1]!.style.transform, items[2]!.style.transform]).toEqual(['translateY(85px)', 'translateY(-40px)', 'translateY(-40px)'])

    const native = new Event('dragstart', { bubbles: true, cancelable: true })

    document.dispatchEvent(native)
    pointer(document, 'pointerup', 5, 105)

    expect([native.defaultPrevented, moves]).toEqual([true, [[0, 2]]])
    expect(items.map(item => item.style.transform)).toEqual(['', '', ''])
  })

  test('swallows the click a drag\'s release sends, and drops nothing on Escape or a cancelled pointer', async () => {
    const { moves, handles: [first, second] } = stacked()
    let clicks = 0

    first!.addEventListener('click', () => clicks++)
    pointer(first!, 'pointerdown', 5, 20)
    pointer(document, 'pointermove', 5, 105)
    pointer(document, 'pointerup', 5, 105)
    first!.click()
    await settle()

    pointer(second!, 'pointerdown', 5, 60)
    pointer(document, 'pointermove', 5, 105)
    press(document, 'Escape')
    pointer(document, 'pointerup', 5, 105)

    pointer(second!, 'pointerdown', 5, 60)
    pointer(document, 'pointermove', 5, 5)
    pointer(document, 'pointercancel', 5, 5)

    expect([clicks, moves]).toEqual([0, [[0, 2]]])
  })

  test('starts a touch drag after a hold, and leaves a touch that moves first to scroll the page', async () => {
    const { moves, handles: [first], items } = stacked()

    pointer(first!, 'pointerdown', 5, 20, 'touch')
    pointer(document, 'pointermove', 5, 60, 'touch')
    await Bun.sleep(ACTIVATION_DELAY_MS + 50)

    expect(items[0]!.style.position).toBe('')

    pointer(document, 'pointerup', 5, 60, 'touch')
    pointer(first!, 'pointerdown', 5, 20, 'touch')
    await Bun.sleep(ACTIVATION_DELAY_MS + 50)

    expect(items[0]!.style.position).toBe('relative')

    pointer(document, 'pointermove', 5, 65, 'touch')
    pointer(document, 'pointerup', 5, 65, 'touch')

    expect(moves).toEqual([[0, 1]])
  })
})

describe('Board, by pointer', () => {
  test('names the container and slot under a dragged card, moves the card there on release, swallowing its click, and moves nothing on Escape', async () => {
    const moves: unknown[] = []
    const board = new Board({ onMove: move => void moves.push(move) })
    const area = stage()

    area.innerHTML = '<div id="todo"><div id="a">A</div><div id="b">B</div></div><div id="done"><div id="c">C</div></div>'

    const at = (id: string) => area.querySelector<HTMLElement>(`#${id}`)!

    board.container('todo')(at('todo'))
    board.container('done')(at('done'))
    board.item('a', 'todo')(at('a'))
    board.item('b', 'todo')(at('b'))
    board.item('c', 'done')(at('c'))
    box(at('todo'), 0, 0, 300, 100)
    box(at('done'), 0, 100, 300, 100)
    box(at('a'), 0, 10, 100, 40)
    box(at('b'), 110, 10, 100, 40)
    box(at('c'), 0, 110, 100, 40)

    pointer(at('a'), 'pointerdown', 50, 30)
    pointer(document, 'pointermove', 150, 130)

    expect([board.dragging(), board.drop()?.container, board.drop()?.index]).toEqual(['a', 'done', 1])
    expect(document.body.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)

    let clicks = 0

    at('a').addEventListener('click', () => clicks++)
    pointer(document, 'pointerup', 150, 130)
    at('a').click()
    await settle()

    expect([moves, clicks]).toEqual([[{ item: 'a', from: 'todo', to: 'done', index: 1 }], 0])
    expect([board.dragging(), board.drop()]).toEqual([null, null])
    expect(document.body.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)

    pointer(at('b'), 'pointerdown', 150, 30)
    pointer(document, 'pointermove', 150, 130)
    press(document, 'Escape')
    pointer(document, 'pointerup', 150, 130)
    await settle()

    expect(moves).toHaveLength(1)
  })
})

describe('Board, from the keyboard', () => {
  async function board() {
    mounted = await mount('src/components/board-columns.kay')

    const { root } = mounted
    const titles = (column: string) => [...root.querySelector(`[aria-label="${column}"]`)!.querySelectorAll('button')].map(item => item.textContent?.trim())

    return { root, titles }
  }

  test('moves a focused card within its container, and into the next one at the same slot', async () => {
    const { root, titles } = await board()

    press(button(root, 'Plan'), 'ArrowRight')
    await settle()

    expect(titles('todo')).toEqual(['Build', 'Plan'])

    press(button(root, 'Plan'), 'ArrowDown')
    await settle()

    expect(titles('todo')).toEqual(['Build'])
    expect(titles('done')).toEqual(['Ship', 'Plan'])
    expect(button(root, 'Plan').getAttribute('aria-keyshortcuts')).toBe('ArrowLeft ArrowRight ArrowUp ArrowDown')
  })

  test('keeps focus on a card its keyed list moved into another container', async () => {
    const { root, titles } = await board()

    button(root, 'Ship').focus()
    press(button(root, 'Ship'), 'ArrowUp')
    // A microtask only, since a key pressed right after the move must already find focus on the card.
    await Promise.resolve()

    expect(titles('todo')).toEqual(['Ship', 'Plan', 'Build'])
    expect(document.activeElement).toBe(button(root, 'Ship'))
  })

  test('leaves out a container the page no longer renders', () => {
    const moves: unknown[] = []
    const board = new Board({ onMove: move => void moves.push(move) })
    const area = stage()

    area.innerHTML = '<div id="todo"><button id="plan">Plan</button></div><div id="done"></div>'
    board.container('todo')(area.querySelector<HTMLElement>('#todo')!)
    board.container('done')(area.querySelector<HTMLElement>('#done')!)
    board.item('plan', 'todo')(area.querySelector<HTMLElement>('#plan')!)
    area.querySelector('#done')!.remove()
    // Either way, since a removed node sorts against the page in no set order.
    press(area.querySelector('#plan')!, 'ArrowDown')
    press(area.querySelector('#plan')!, 'ArrowUp')

    expect(moves).toEqual([])
  })

  test('leaves the cards alone under a modifier chord', async () => {
    const { root, titles } = await board()

    press(button(root, 'Plan'), 'ArrowRight', { ctrlKey: true })
    await settle()

    expect(titles('todo')).toEqual(['Plan', 'Build'])
  })
})

describe('DropTargets, by pointer', () => {
  test('marks the innermost accepting target under a dragged item, and drops onto it', async () => {
    const drops: [string, string][] = []
    const targets = new DropTargets<string, string>({ accepts: (_, target) => target !== 'locked', onDrop: (item, target) => void drops.push([item, target]) })
    const area = stage()

    area.innerHTML = '<div id="folder"><div id="inner"></div></div><div id="locked"></div><div id="note">Note</div>'

    for (const id of ['folder', 'inner', 'locked'])
      targets.target(id)(area.querySelector<HTMLElement>(`#${id}`)!)

    targets.item('note')(area.querySelector<HTMLElement>('#note')!)

    // happy-dom lays nothing out: left of 100px the pointer is over the folder's inner row, right of it over the locked target.
    const { elementFromPoint } = document

    document.elementFromPoint = (x: number) => area.querySelector(x < 100 ? '#inner' : '#locked')

    try {
      const pointer = (type: string, x: number) => (type === 'pointerdown' ? area.querySelector('#note')! : document).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 0, button: 0, pointerType: 'mouse', bubbles: true }))

      pointer('pointerdown', 0)
      pointer('pointermove', 5)

      expect(targets.dragging()).toBeNull()

      pointer('pointermove', 120)

      expect([targets.dragging(), targets.over()]).toEqual(['note', null])

      pointer('pointermove', 20)

      expect(targets.over()).toBe('inner')

      pointer('pointerup', 20)
      await settle()

      expect(drops).toEqual([['note', 'inner']])
      expect([targets.dragging(), targets.over()]).toEqual([null, null])
      expect(document.body.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0)
    }
    finally {
      document.elementFromPoint = elementFromPoint
    }
  })
})
