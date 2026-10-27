import type { FetchedIsland } from './fetch-island'
import type { Policy } from './swap-flight'
import { ISLAND } from './markers'
import { moves, place } from './move'
import { navigation } from './navigation'
import { runnable, scriptMarkup } from './swap-head'
import { morphChildren } from './swap-morph'
import { decodeServerValue } from './wire'

const PERSISTENT = 'slot[data-persist]'
const SERVER_ISLAND = 'slot[data-kay-server]'
// What a script put in the body to outlive every page, a live region an announcer fills for one: the next body never holds it, so the morph leaves it where it is, never moved, as a live region taken out and put back may go unread.
const LASTING = ':scope > [data-kay-keep]'

interface KeptIsland extends HTMLElement {
  // Set by the entry once the island hydrated: gives it new props.
  _$p?: (props: object) => void
  // Set by an island with static slots as it hydrates: its server markup, which a refresh compares.
  _$h?: string
}

// The next page's body morphed into this one: what it renders again stays the same element, so a layout's sidebar keeps its scroll, and the islands that live on are moved over before anything is taken away, so a playing video or an open socket never notices.
export function swapBody(next: Document, policy: Policy): void {
  const body = document.adoptNode(next.body)
  const old = document.body
  const focused = heldFocus()

  const kept = new Set<Element>()
  // The scroll of each element an island kept holds, which a move resets in a browser without `moveBefore`, and Chrome's swap loses with it too (a bare pair of moves keeps it, the swap's does not), so a restore puts back the ones the swap kept either way.
  const scrolls = new Map<Element, readonly [left: number, top: number]>()

  // Read before the first move, and only when the next page has an island to keep, so every read shares one layout instead of forcing one after each move.
  const candidates = policy.islands === 'unchanged' ? `${PERSISTENT},${ISLAND}` : PERSISTENT

  for (const root of body.querySelector(candidates) ? old.querySelectorAll(candidates) : []) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const { scrollLeft, scrollTop } = element

      if (scrollLeft !== 0 || scrollTop !== 0)
        scrolls.set(element, [scrollLeft, scrollTop])
    }
  }

  // With `moveBefore`, an island kept waits in a connected element while the morph runs, so each move keeps its state, and the next body holds its placeholder, emptied, in its stead; elsewhere a move resets the state either way, so it goes straight into the next body.
  const standIns = new Map<Element, Element>()
  let parking: HTMLElement | undefined

  const keep = (placeholder: Element, live: Element) => {
    kept.add(live)

    if (!moves) {
      placeholder.replaceWith(live)

      return
    }

    parking ??= document.documentElement.appendChild(document.createElement('div'))
    place(parking, live, null)
    placeholder.replaceChildren()
    standIns.set(placeholder, live)
  }

  for (const placeholder of body.querySelectorAll<HTMLElement>(PERSISTENT)) {
    const live = old.querySelector<KeptIsland>(`${PERSISTENT}[data-persist="${CSS.escape(placeholder.dataset.persist!)}"]`)

    if (live && live.dataset.component === placeholder.dataset.component) {
      keep(placeholder, live)

      const props = placeholder.dataset.props

      // What the next page gives it, which it reads from now on, or once it hydrates.
      if (props !== live.dataset.props) {
        if (props === undefined)
          delete live.dataset.props
        else
          live.dataset.props = props

        live._$p?.(props === undefined ? {} : decodeServerValue(props) as object)
      }
    }
  }

  if (policy.islands === 'unchanged') {
    const unchanged = [...old.querySelectorAll<KeptIsland>(ISLAND)]

    for (const placeholder of body.querySelectorAll<HTMLElement>(ISLAND)) {
      // One in the static slot of an island kept went along with it, or away with the copy it replaced.
      if (!body.contains(placeholder) || standIns.has(placeholder) || [...kept].some(island => island.contains(placeholder)))
        continue

      const index = unchanged.findIndex(live => old.contains(live) && live.dataset.component === placeholder.dataset.component && live.dataset.props === placeholder.dataset.props && live.dataset.slots === placeholder.dataset.slots && (live.dataset.slots === undefined || (live._$h ?? live.innerHTML) === placeholder.innerHTML))

      if (index !== -1) {
        const [live] = unchanged.splice(index, 1)

        keep(placeholder, live!)
      }
    }
  }

  // Every island left is taken away, as the morph never keeps one.
  navigation.hooks!.dispose(old)

  // A browser without popovers throws on the selector. One open in an island kept closes too, as it did when moving the island hid it.
  const opened = 'popover' in HTMLElement.prototype ? [old, ...kept].flatMap(root => [...root.querySelectorAll(':popover-open')]) : []

  holdFetched(old, body)

  // What ran already, the hydration script for one, runs once.
  const ran = new Set([...document.scripts].map(scriptMarkup))

  for (const script of body.querySelectorAll('script')) {
    const markup = script.outerHTML

    if (ran.has(markup))
      script.remove()
    else
      script.replaceWith(runnable(script, markup))
  }

  // The server writes `<body>` bare, so every attribute it holds is a script's.
  try {
    morphChildren(old, body, new Set(old.querySelectorAll(LASTING)))

    for (const [standIn, live] of standIns) {
      if (standIn.isConnected)
        place(standIn.parentNode!, live, standIn)

      standIn.remove()
    }
  }
  finally {
    parking?.remove()
  }

  for (const [element, [left, top]] of scrolls) {
    if (element.isConnected && (element.scrollLeft !== left || element.scrollTop !== top))
      element.scrollTo({ left, top, behavior: 'instant' })
  }

  if (focused && document.activeElement !== focused.element && [...kept].some(island => island.contains(focused.element)))
    focused.restore()

  // A drawer or a menu left open closes as the page changes, as it would on a page loaded afresh.
  for (const popover of opened) {
    if (popover.isConnected && popover instanceof HTMLElement && popover.matches(':popover-open'))
      popover.hidePopover()
  }

  // A new page starts at the top in the element holding its heading too, such as a main column scrolling on its own.
  if (policy.scroll === 'top') {
    for (let parent = (document.querySelector('[autofocus]') ?? document.querySelector('h1'))?.parentElement; parent && parent !== document.body; parent = parent.parentElement)
      parent.scrollTo(0, 0)
  }
}

// The focused element with its caret and selection, which moving the island holding it takes away in a browser without `moveBefore`: the swap gives them back, so a field typed in keeps taking the keys.
function heldFocus(): { element: HTMLElement, restore: () => void } | undefined {
  const element = document.activeElement

  if (!(element instanceof HTMLElement) || element === document.body)
    return undefined

  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.selectionStart !== null) {
    const { selectionStart: start, selectionEnd: end, selectionDirection: direction, scrollLeft, scrollTop } = element

    return {
      element,
      restore: () => {
        element.focus({ preventScroll: true })
        element.setSelectionRange(start, end, direction ?? undefined)
        element.scrollLeft = scrollLeft
        element.scrollTop = scrollTop
      },
    }
  }

  // Offsets rather than a range: a live range moves out of the island as it is taken out.
  const selection = document.getSelection()
  const at = selection?.anchorNode && selection.focusNode ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] as const : undefined

  return {
    element,
    restore: () => {
      element.focus({ preventScroll: true })

      if (at && element.contains(at[0]) && element.contains(at[2]) && fits(at[0], at[1]) && fits(at[2], at[3]))
        document.getSelection()?.setBaseAndExtent(...at)
    },
  }
}

// Whether an offset is still inside a node, which an island's render may have shortened.
function fits(node: Node, offset: number): boolean {
  return offset <= (node instanceof CharacterData ? node.length : node.childNodes.length)
}

// A deferred server island already fetched shows its render while the next page's copy of it is fetched, rather than the inert copy standing in for it: a post back to the same page keeps the island on screen, and the scroll with it. It stays inert until the fetch answers, and one the next page renders another copy of is replaced by it at once.
function holdFetched(old: Element, body: Element): void {
  const fetched = new Map<string | undefined, FetchedIsland>()
  const active = document.activeElement

  for (const live of old.querySelectorAll<FetchedIsland>(SERVER_ISLAND)) {
    if (live._$b !== undefined && !live.hasAttribute('inert'))
      fetched.set(live.dataset.kayServer, live)
  }

  for (const placeholder of fetched.size === 0 ? [] : body.querySelectorAll<FetchedIsland>(SERVER_ISLAND)) {
    const live = fetched.get(placeholder.dataset.kayServer)
    const markup = placeholder.innerHTML

    if (live === undefined || live._$b !== markup)
      continue

    const focused = active instanceof HTMLElement && live.contains(active) ? active : undefined

    placeholder.replaceChildren(...live.childNodes)
    placeholder._$b = markup

    // The morph may keep the live element rather than the placeholder, so both carry it.
    if (focused) {
      live._$f = focused
      placeholder._$f = focused
    }

    // An island of the held render still waiting to hydrate never does: the next render replaces it.
    for (const island of placeholder.querySelectorAll<HTMLElement>(ISLAND)) {
      delete island.dataset.component
      delete island.dataset.chunk
    }
  }
}
