import type { DevTool } from './dev-tool'
import { HOST } from './dev-tool-constants'
import { SVG } from './dev-tool-icons'
import { boundsOf } from './dev-tool-parts'

// The dev tool's overlay of the tab order. Split from dev-tool.ts, which the dev server serves with the modules it imports.

const FOCUSABLE = 'a[href], area[href], button, input:not([type=hidden]), select, textarea, details > summary:first-of-type, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable=false]), [tabindex]'
// Re-reading the page waits for the mutations to settle, and the focus check, which moves focus, for the list of stops or a class or style to change.
const TAB_ORDER_WAIT = 150
const TAB_ORDER_MAX_REPORTED = 5
const FOCUS_ANCESTORS = 4
const WCAG = 'https://www.w3.org/WAI/WCAG22/Understanding'

// What a focus ring or a focus style would change on an element: its outline, shadow, borders, colours and decoration.
const FOCUS_STYLES = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'backgroundColor', 'color', 'textDecorationLine', 'textDecorationColor', 'filter'] as const

// A problem the tab order overlay found, worded as an accessibility rule so the Problems tab lists it and hovering it outlines its elements.
export interface TabOrderIssue {
  id: string
  help: string
  helpUrl: string
  elements: Element[]
}

// The elements the keyboard reaches, in the order Tab walks them: a positive `tabindex` first, smallest first, then the rest as the page is laid out, an open shadow root's contents where its host has them and a slot's where its assigned elements go. What is not rendered, disabled, inert, or out of the order with `tabindex="-1"` is left out, as is all but one radio of a group and the dev tool itself.
export function tabStops(doc: Document): HTMLElement[] {
  return reach(doc).stops
}

// The tab stops and the open shadow roots holding some.
interface Reach {
  stops: HTMLElement[]
  roots: ShadowRoot[]
}

// Visits the page's elements as they are laid out: an open shadow root's contents where its host has them and a slot's where its assigned elements go. `visit` returns false to leave an element's contents out. Gives the open shadow roots met.
export function walkComposed(doc: Document, visit: (element: Element) => boolean): ShadowRoot[] {
  const roots: ShadowRoot[] = []

  function visitChildren(parent: Document | ShadowRoot | Element): void {
    for (const child of parent.children)
      walk(child)
  }

  function walk(element: Element): void {
    if (!visit(element))
      return

    if (element instanceof HTMLSlotElement) {
      for (const node of element.assignedElements().length > 0 ? element.assignedElements() : element.children)
        walk(node)
    }
    else if (element.shadowRoot === null) {
      visitChildren(element)
    }
    else {
      roots.push(element.shadowRoot)
      visitChildren(element.shadowRoot)
    }
  }

  visitChildren(doc)

  return roots
}

function reach(doc: Document): Reach {
  const found: HTMLElement[] = []
  const roots = walkComposed(doc, (element) => {
    if (element.localName === HOST || element.hasAttribute('inert'))
      return false

    if (element instanceof HTMLElement && element.matches(FOCUSABLE) && isStop(element))
      found.push(element)

    return true
  })
  const positive = found.filter(element => element.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex)

  return { stops: [...positive, ...found.filter(element => element.tabIndex === 0)], roots }
}

function isStop(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled'))
    return false

  // Not rendered: display none, or a hidden ancestor.
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ visibilityProperty: true }))
    return false

  return !(element instanceof HTMLInputElement) || element.type !== 'radio' || element.name === '' || element === radioStop(element)
}

// The one radio of a group the keyboard stops at: the checked one, else the first.
function radioStop(radio: HTMLInputElement): HTMLInputElement | undefined {
  const group = [...(radio.form ?? radio.getRootNode() as Document | ShadowRoot).querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(other => other.name === radio.name && other.form === radio.form)

  return group.find(other => other.checked) ?? group[0]
}

// Where the keyboard moves up the page: a stop drawn entirely above the one Tab leaves.
export function tabJumps(stops: HTMLElement[], rects: DOMRect[]): number[] {
  const jumps: number[] = []

  for (let index = 1; index < stops.length; index++) {
    if (rects[index]!.bottom <= rects[index - 1]!.top)
      jumps.push(index)
  }

  return jumps
}

// The element around another, across a shadow root's edge.
function parentOf(node: Element): Element | null {
  const root = node.getRootNode()

  return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
}

// What a style would show of the element and of the few elements around it that can carry its focus style.
function focusLook(element: HTMLElement): string {
  const looks: string[] = []

  for (let node: Element | null = element, depth = 0; node !== null && depth <= FOCUS_ANCESTORS; node = parentOf(node), depth++) {
    const style = getComputedStyle(node)

    looks.push(FOCUS_STYLES.map(property => style[property]).join('|'))
  }

  return looks.join('||')
}

// The element focus is on, down through open shadow roots.
function deepActive(doc: Document): HTMLElement | null {
  let active = doc.activeElement as HTMLElement | null

  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement as HTMLElement

  return active
}

// The elements that may hold a shadow root besides a custom element.
const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span'])

// Whether the element focus is on may be a host whose closed shadow root holds it: the page reports the host either way, and a host given a tabindex looks as focusable as an element holding focus itself.
function maybeClosedHost(element: HTMLElement): boolean {
  return element.shadowRoot === null && (element.localName.includes('-') || SHADOW_HOSTS.has(element.localName))
}

// The stops whose focus shows nothing: focused, neither they nor the elements around them change how they look. Only elements the browser would show a focus ring on count, as it shows none on a button after a click; focus moves from stop to stop and returns to where it was. Nothing is checked, and undefined returned, while focus may be inside a closed shadow root, which the tool cannot give focus back to.
function hiddenFocus(doc: Document, stops: HTMLElement[], roots: ShadowRoot[]): HTMLElement[] | undefined {
  const win = doc.defaultView!
  const before = deepActive(doc)

  if (before !== null && before !== doc.body && before !== doc.documentElement && (!before.matches(FOCUSABLE) || maybeClosedHost(before)))
    return undefined

  const still = new win.CSSStyleSheet()
  const trees = [doc, ...roots]
  const hidden: HTMLElement[] = []

  // A transition would leave the look unchanged for a moment.
  still.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }')

  for (const tree of trees)
    tree.adoptedStyleSheets = [...tree.adoptedStyleSheets, still]

  try {
    for (const stop of stops) {
      const look = focusLook(stop)

      stop.focus({ preventScroll: true })

      if ((stop.getRootNode() as Document | ShadowRoot).activeElement === stop && stop.matches(':focus-visible') && focusLook(stop) === look)
        hidden.push(stop)

      stop.blur()
    }
  }
  finally {
    for (const tree of trees)
      tree.adoptedStyleSheets = tree.adoptedStyleSheets.filter(sheet => sheet !== still)

    before?.focus({ preventScroll: true })

    if (before === null || before === doc.body)
      (doc.activeElement as HTMLElement | null)?.blur()
  }

  return hidden
}

// Where the keyboard may not leave: an `inert` part of the page holding focusable elements while no modal dialog is open, and a modal that is not a `dialog` element, which only a script keeps focus in.
function trapSuspects(doc: Document): { inert: Element[], modals: Element[] } {
  let dialog = false

  try {
    dialog = doc.querySelector('dialog:modal') !== null
  }
  catch {}

  const rendered = (element: Element) => typeof element.checkVisibility !== 'function' || element.checkVisibility()
  const inert = dialog ? [] : [...doc.querySelectorAll('[inert]')].filter(element => element.parentElement?.closest('[inert]') == null && (element.matches(FOCUSABLE) || element.querySelector(FOCUSABLE) !== null))
  const modals = [...doc.querySelectorAll('[aria-modal="true"]')].filter(element => !(element instanceof HTMLDialogElement) && rendered(element))

  return { inert: inert.filter(rendered), modals }
}

// A selector reaching the element: by its id, or by its tag and place from the nearest id or the page.
function selectorOf(element: Element): string {
  const parts: string[] = []

  for (let node: Element | null = element; node !== null && node !== node.ownerDocument.documentElement; node = node.parentElement) {
    if (node.id !== '') {
      parts.unshift(`#${CSS.escape(node.id)}`)

      break
    }

    const same = [...node.parentElement?.children ?? []].filter(sibling => sibling.localName === node.localName)

    parts.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName)
  }

  return parts.join(' > ')
}

// The warning an issue logs, in the shape of the accessibility check's: the rule and what it asks, then the elements, a few at most, and where it explains.
export function tabOrderProblem(issue: TabOrderIssue): string {
  const shown = issue.elements.slice(0, TAB_ORDER_MAX_REPORTED).map(element => `  ${selectorOf(element)}`)
  const more = issue.elements.length > TAB_ORDER_MAX_REPORTED ? [`  and ${issue.elements.length - TAB_ORDER_MAX_REPORTED} more`] : []

  return [`[kay] a11y ${issue.id}: ${issue.help}`, ...shown, ...more, issue.helpUrl].join('\n')
}

export interface TabOrder {
  show: (on: boolean) => void
  stop: () => void
}

const TAB_ORDER_OBSERVED = { subtree: true, childList: true, attributes: true, attributeFilter: ['tabindex', 'disabled', 'hidden', 'inert', 'open', 'href', 'class', 'style', 'aria-modal', 'aria-busy'] }

// What the overlay found in the page, which a scroll frame draws again without looking for it again.
interface TabScan extends Reach {
  inert: Element[]
  modals: Element[]
}

const NO_SCAN: TabScan = { stops: [], roots: [], inert: [], modals: [] }

// The overlay of the tab order: a numbered badge on each stop and a line between them, a jump up the page dashed in red, what it finds logged as accessibility problems. It reads the page again after it changes or resizes, moves the badges as it scrolls, and does nothing while hidden.
export function startTabOrder(doc: Document, root: ShadowRoot, make: DevTool['make']): TabOrder {
  const win = doc.defaultView!
  const layer = make('div', 'tab-order')
  const svg = doc.createElementNS(SVG, 'svg')
  const logged = new Set<string>()
  let found = NO_SCAN
  // Whether the page changed since it was read.
  let stale = true
  // The stops the focus check ran on, which it runs on again when they change or when a class or style change may have changed a focus ring.
  let checked: HTMLElement[] = []
  let restyled = true
  let hidden = new Set<HTMLElement>()
  let on = false
  let frame = 0
  let timer = 0
  const busy = () => doc.documentElement.hasAttribute('aria-busy')
  const changes = new MutationObserver((records) => {
    // A page swap drops the old page's problems with it.
    if (busy()) {
      logged.clear()
      checked = []
      found = NO_SCAN
      repaint()
    }

    if (records.some(record => record.type === 'attributes' && (record.attributeName === 'class' || record.attributeName === 'style')))
      restyled = true

    stale = true
    schedule()
  })
  const move = () => repaint()
  const resize = () => {
    stale = true
    schedule()
  }
  const sameStops = (stops: HTMLElement[]) => stops.length === checked.length && stops.every((stop, index) => stop === checked[index])

  svg.setAttribute('aria-hidden', 'true')
  layer.hidden = true
  layer.append(svg)
  root.append(layer)

  // After the page stops changing for a moment its issues are read and the overlay drawn.
  function schedule(): void {
    if (!on)
      return

    win.clearTimeout(timer)
    timer = win.setTimeout(analyse, TAB_ORDER_WAIT)
  }

  // The next frame moves the overlay to where the stops are now.
  function repaint(): void {
    if (on && frame === 0)
      frame = win.requestAnimationFrame(redraw)
  }

  function report(issues: TabOrderIssue[]): void {
    for (const issue of issues) {
      const text = tabOrderProblem(issue)

      if (issue.elements.length > 0 && !logged.has(text)) {
        logged.add(text)
        console.warn(text)
      }
    }
  }

  function scan(): void {
    stale = false

    const reached = reach(doc)

    found = { ...reached, ...trapSuspects(doc) }

    // Changes inside an open shadow root are not seen from the page's.
    for (const shadow of reached.roots)
      changes.observe(shadow, TAB_ORDER_OBSERVED)
  }

  function analyse(): void {
    timer = 0

    if (!on || busy())
      return

    if (stale)
      scan()

    const { stops, inert, modals } = found

    if (restyled || !sameStops(stops)) {
      const result = hiddenFocus(doc, stops, found.roots)

      if (result !== undefined) {
        checked = stops
        hidden = new Set(result)
        restyled = false
      }

      // Moving focus may have changed the page, which is not a change to read again.
      changes.takeRecords()
    }

    const rects = stops.map(stop => stop.getBoundingClientRect())
    const jumps = tabJumps(stops, rects)

    report([
      { id: 'tab-order-jump', help: 'The keyboard moves up the page from the previous element, because of a positive tabindex or a visual order unlike the DOM\'s', helpUrl: `${WCAG}/focus-order.html`, elements: jumps.map(index => stops[index]!) },
      { id: 'focus-not-visible', help: 'Focus shows nothing on this element, give it an outline or a ring', helpUrl: `${WCAG}/focus-visible.html`, elements: [...hidden] },
      { id: 'keyboard-trap', help: 'Part of the page the keyboard cannot reach while no dialog is open', helpUrl: `${WCAG}/no-keyboard-trap.html`, elements: inert },
      { id: 'keyboard-trap', help: 'A modal that is not an open dialog element, which only a script keeps focus in: check Tab and Escape leave it', helpUrl: `${WCAG}/no-keyboard-trap.html`, elements: modals },
    ])
    draw(rects)
  }

  function redraw(): void {
    frame = 0

    if (!on || busy()) {
      clear()

      return
    }

    // A change waiting to be read draws itself when it is.
    if (stale && timer !== 0)
      return

    if (stale)
      scan()

    draw(found.stops.map(stop => stop.getBoundingClientRect()))
  }

  function clear(): void {
    svg.replaceChildren()
    layer.replaceChildren(svg)
  }

  function draw(rects: DOMRect[]): void {
    clear()

    const { stops, inert, modals } = found
    const jumps = new Set(tabJumps(stops, rects))
    const width = win.innerWidth
    const height = win.innerHeight

    for (const trap of [...inert, ...modals]) {
      const box = boundsOf(trap)
      const element = make('div', 'tab-trap')

      element.style.left = `${box.left}px`
      element.style.top = `${box.top}px`
      element.style.width = `${box.width}px`
      element.style.height = `${box.height}px`
      layer.append(element)
    }

    for (let index = 1; index < stops.length; index++) {
      const from = rects[index - 1]!
      const to = rects[index]!
      const path = doc.createElementNS(SVG, 'path')

      path.setAttribute('d', `M${from.left + from.width / 2} ${from.top + from.height / 2}L${to.left + to.width / 2} ${to.top + to.height / 2}`)

      if (jumps.has(index))
        path.setAttribute('class', 'jump')

      svg.append(path)
    }

    for (const [index, stop] of stops.entries()) {
      const rect = rects[index]!

      if (rect.right < 0 || rect.bottom < 0 || rect.left > width || rect.top > height)
        continue

      const flags = [jumps.has(index) ? 'jump' : '', hidden.has(stop) ? 'hidden-focus' : ''].filter(flag => flag !== '')
      const badge = make('div', `tab-badge ${flags.join(' ')}`, `${index + 1}${flags.length > 0 ? ' !' : ''}`)

      badge.style.left = `${Math.max(0, rect.left - 6)}px`
      badge.style.top = `${Math.max(0, rect.top - 9)}px`
      layer.append(badge)
    }
  }

  function show(value: boolean): void {
    on = value
    layer.hidden = !on
    win.clearTimeout(timer)
    timer = 0
    win.cancelAnimationFrame(frame)
    frame = 0
    logged.clear()
    checked = []
    found = NO_SCAN
    stale = true
    restyled = true
    hidden = new Set()
    changes.disconnect()

    if (!on) {
      win.removeEventListener('scroll', move, true)
      win.removeEventListener('resize', resize)
      clear()

      return
    }

    win.addEventListener('scroll', move, { capture: true, passive: true })
    win.addEventListener('resize', resize)
    changes.observe(doc.documentElement, TAB_ORDER_OBSERVED)
    schedule()
  }

  return {
    show,
    stop: () => show(false),
  }
}
