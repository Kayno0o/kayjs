// What islands run on in the browser: DOM built from templates, kept in step with signals, and the server's markup claimed in place when an island hydrates.
// A dynamic part sits between `<!--[-->` and `<!--]-->` comments unless it is the only content of its element; hydration walks the server's nodes in the order the generated code asks for them.

import type { Owner } from './reactive'
import { rebasedAttribute } from './base'
import { frenchText, frenchTree } from './french'
import { ISLAND, PART_END, PART_START } from './markers'
import { place } from './move'
import { browserKeepsSameTab, leavesSite } from './outside'
import { activeOwner, hydrationEnded, hydrationStarted, isHydrating, memo, onCleanup, renderEffect, root, runWithOwner, scope, unrecorded, untrack } from './reactive'
import { clearHeldMarkup, isHeldMarkup } from './safe-html'
import { freshPrefix, withIds } from './uid'
import { safeUrl } from './url'
import { attributeValue, classText, eachChild, styleText } from './values'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

declare const KAY_FRENCH: true | undefined

export { holdSubmits, listenSubmit } from './form-hold'
export { renderEffect as effect, memo, untrack } from './reactive'
export { transition } from './transition'
export { componentClass, merge, omit, partClass, partHanded, partsClass, spreadAttributes, spreadWith } from './values'

// Several sibling nodes rendered as one: a block or a component returning more than one node. Its first and last nodes stay in place while what sits between changes.
export class Range {
  // What holds it while it is out: its nodes stay siblings there, so a part inside it goes on updating, and a walk from `first` finds them all.
  held?: DocumentFragment | undefined
  // The nodes it was made of when it was taken out while some of them play a leave phase, which leave from where they are rather than from `held`.
  nodes?: Node[] | undefined

  constructor(readonly first: Node, readonly last: Node) {}
}

// What a template, a block or a component gives back.
export type Unit = Node | Range

// Where hydration claims its next node: inside `parent`, starting at `next`.
interface Claim {
  parent: Node
  next: Node | null
}

export class HydrationMismatchError extends Error {
  override name = 'HydrationMismatchError'
}

/** @deprecated Renamed `HydrationMismatchError` in 1.70; the old name goes in 1.73. */
export const HydrationMismatch = HydrationMismatchError
/** @deprecated Renamed `HydrationMismatchError` in 1.70; the old name goes in 1.73. */
export type HydrationMismatch = HydrationMismatchError

const TAG_END = /[\s>]/
const VOID_PROPERTIES = new Set(['value', 'checked', 'selected', 'muted', 'indeterminate'])
const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText'])
// Events handled by one listener on the document, as most pages bind them on many elements at once.
const DELEGATED = /^(?:beforeinput|click|dblclick|contextmenu|focus(?:in|out)|input|key(?:down|up)|mouse(?:down|move|out|over|up)|pointer(?:down|move|out|over|up)|touch(?:end|move|start))$/

// The events the document already has a listener for, kept on the document so a second copy of this runtime on the page adds none of its own.
interface DelegatingDocument extends Document {
  _$kt?: Set<string>
}

let claim: Claim | undefined

// Whether an island is hydrating, claiming the server's nodes rather than building them.
export function claiming(): boolean {
  return claim !== undefined
}

// The element being claimed in, inside the island being hydrated, which orders the titles of several by their place in the page.
export function islandHost(): Element | undefined {
  return claim?.parent as Element | undefined
}

// What plays an element's transition, set by the first one a template sets, so a page whose islands set none ships none of its code.
export interface Transitions {
  has: (node: Node) => node is Element
  enter: (node: Node) => void
  leave: (node: Node) => void
  // The elements playing their leave phase.
  leaving: ReadonlySet<Node>
  // Ends the leave phase of the elements, which play their enter phase instead.
  back: (nodes: Node[]) => void
}

let transitions: Transitions | undefined

export function playTransitions(given: Transitions): void {
  transitions = given
}

// Gives a link an island writes its copy in the page's locale, set by kay/i18n, so a page of an app without locales ships none of its code.
let localizeHref = (href: string) => href

export function localizeLinks(given: (href: string) => string): void {
  localizeHref = given
}

type ElementRecord = Element & Record<string, unknown>

// ---- hydration

// Runs `render` claiming the nodes already inside `container`, the server's markup of an island.
export function hydrate<T>(render: () => T, container: Node): T {
  const previous = claim

  claim = { parent: container, next: container.firstChild }
  hydrationStarted()

  try {
    return untrack(render)
  }
  finally {
    claim = previous
    hydrationEnded()

    // An island nested in another's render leaves the outer one's stand-ins.
    if (!isHydrating())
      clearHeldMarkup()
  }
}

// Runs `render` building new nodes even while an island hydrates: a client-only component has no server markup to claim.
// Its ids come from a prefix of its own, so the island around it counts the same as on the server, which rendered nothing for it.
export function fresh<T>(render: () => T): T {
  const previous = claim

  claim = undefined

  try {
    return withIds(freshPrefix(), render)
  }
  finally {
    claim = previous
  }
}

export function claimNode(): Node {
  const node = claim!.next

  if (!node)
    throw new HydrationMismatchError('the server markup ended before the island did')

  claim!.next = node.nextSibling

  return node
}

// Claims a text node holding `data`, making one when the server wrote nothing, as for an empty string.
// On a page in French the data is spaced as the server spaced the markup, so the text it wrote stays.
function claimText(data: string): Text {
  const next = claim!.next

  if (typeof KAY_FRENCH !== 'undefined')
    data = frenchText(data, claim!.parent)

  if (next?.nodeType === 3) {
    claim!.next = next.nextSibling

    if ((next as Text).data !== data)
      (next as Text).data = data

    return next as Text
  }

  const text = document.createTextNode(data)

  claim!.parent.insertBefore(text, next)

  return text
}

// The `]` closing the `[` given, past any dynamic part nested between them: the server leaves a part's content between its markers.
export function close(start: Node): Node {
  let depth = 0

  for (let node = start.nextSibling; node; node = node.nextSibling) {
    if (node.nodeType !== 8)
      continue

    const data = (node as Comment).data

    if (data === PART_START)
      depth++
    else if (data === PART_END && depth-- === 0)
      return node
  }

  throw new HydrationMismatchError('a dynamic part of the server markup has no end')
}

// ---- building

// A template's root element, cloned, or claimed from the server markup when hydrating.
export function template(html: string): () => Element {
  const tag = html.slice(1, html.search(TAG_END)).toUpperCase()
  let node: Element | undefined

  return () => {
    if (claim) {
      const claimed = claimNode()

      if (claimed.nodeName.toUpperCase() !== tag)
        throw new HydrationMismatchError(`expected <${tag.toLowerCase()}> where the server markup holds ${claimed.nodeName.toLowerCase()}`)

      return claimed as Element
    }

    if (!node) {
      const holder = document.createElement('template')

      holder.innerHTML = html
      node = holder.content.firstChild as Element

      // An SVG child such as `path` is no HTML element: parsed in an `svg`, it gets the SVG namespace.
      if (node instanceof HTMLUnknownElement) {
        holder.innerHTML = `<svg>${html}</svg>`
        node = holder.content.firstChild!.firstChild as Element
      }

      if (typeof KAY_FRENCH !== 'undefined')
        frenchTree(node)
    }

    return node.cloneNode(true) as Element
  }
}

// A block of several items, built in order into a fragment, or claimed in order when hydrating.
export function fragment(build: (parent: Node) => void): Unit | null {
  if (claim) {
    const { parent } = claim
    const first = claim.next

    build(parent)

    const last = claim.next ? claim.next.previousSibling : parent.lastChild

    if (!first || !last || first === claim.next)
      return null

    return first === last ? first : new Range(first, last)
  }

  const holder = document.createDocumentFragment()

  build(holder)

  const { firstChild, lastChild } = holder

  if (!firstChild || !lastChild)
    return null

  return firstChild === lastChild ? firstChild : new Range(firstChild, lastChild)
}

// An element of a block, already claimed when hydrating.
export function append(parent: Node, node: Node): void {
  if (!claim)
    parent.appendChild(node)
}

export function text(parent: Node, data: string): void {
  if (claim)
    claimText(data)
  else
    parent.appendChild(document.createTextNode(typeof KAY_FRENCH === 'undefined' ? data : frenchText(data, parent)))
}

let paragraph: (() => Element) | undefined

// The `p` an `error` line shows a refused form's message in, claimed from the server markup when hydrating; nothing while there is none.
export function errorParagraph(message: string | undefined, id: string, classes: string): Element | undefined {
  if (message === undefined)
    return undefined

  const element = (paragraph ??= template('<p></p>'))()

  if (id !== '')
    element.id = id

  element.className = classes

  if (element.textContent !== message)
    element.textContent = message

  return element
}

// The markers around a dynamic part of a block.
export function markers(parent: Node): [start: Node, end: Node] {
  if (claim) {
    const start = claimNode()

    if (start.nodeType !== 8 || (start as Comment).data !== PART_START)
      throw new HydrationMismatchError(`expected the start of a dynamic part where the server markup holds ${start.nodeName}`)

    const end = close(start)

    claim.next = end.nextSibling

    return [start, end]
  }

  const start = document.createComment(PART_START)
  const end = document.createComment(PART_END)

  parent.appendChild(start)
  parent.appendChild(end)

  return [start, end]
}

// ---- regions

// The content of a dynamic part: what sits between two markers, or all of an element's content.
export class Region {
  constructor(readonly element: Node | null, readonly start: Node | null, readonly end: Node | null) {}

  get parent(): Node {
    return this.start ? this.start.parentNode! : this.element!
  }

  // Runs `fn` claiming the region's content, when hydrating.
  claim<T>(fn: () => T): T {
    if (!claim)
      return fn()

    const previous = claim

    claim = { parent: this.parent, next: this.start ? this.start.nextSibling : this.element!.firstChild }

    try {
      return fn()
    }
    finally {
      claim = previous
    }
  }

  insert(unit: Unit, before: Node | null = this.end): void {
    insertUnit(this.parent, unit, before)
  }

  clear(): void {
    if (!this.start) {
      this.element!.textContent = ''

      return
    }

    const parent = this.parent

    while (this.start.nextSibling && this.start.nextSibling !== this.end)
      parent.removeChild(this.start.nextSibling)
  }
}

export function insertUnit(parent: Node, unit: Unit, before: Node | null): void {
  // Before its own first node: already in place, and moving its nodes one by one before that one would put them in front of it, unless some are gone.
  if (before === firstOf(unit) && !isStale(unit))
    return

  if (!(unit instanceof Range)) {
    place(parent, unit, before)

    return
  }

  for (const node of nodesOf(unit)) {
    // A node of the unit already there stays, the ones after it going behind it.
    if (node === before)
      before = node.nextSibling
    else
      place(parent, node, before)
  }

  unit.nodes = undefined
  unit.held = undefined
}

// Whether some nodes of a unit are not in the document, a unit taken out and not placed again.
function isStale(unit: Unit): boolean {
  return unit instanceof Range && unit.held !== undefined
}

// The nodes a unit is made of, in order.
function nodesOf(unit: Unit): Node[] {
  if (!(unit instanceof Range))
    return [unit]

  if (unit.nodes)
    return withHeld(unit.nodes, unit.held!)

  const nodes: Node[] = []

  for (let node: Node | null = unit.first; node; node = node === unit.last ? null : node.nextSibling)
    nodes.push(node)

  return nodes
}

// The nodes of a range taken out while some of them left: those in order, and between them what `held` has now, a part in it having changed meanwhile.
function withHeld(nodes: Node[], held: DocumentFragment): Node[] {
  const merged: Node[] = []
  let next = held.firstChild

  for (const node of nodes) {
    if (transitions?.has(node)) {
      merged.push(node)
    }
    else if (node.parentNode === held) {
      for (const after = node.nextSibling; next !== after; next = next!.nextSibling)
        merged.push(next!)
    }
  }

  return merged
}

// An element with a `transition` plays its leave phase first; the rest of a range waits in a fragment of its own.
export function removeUnit(unit: Unit): void {
  if (!(unit instanceof Range)) {
    transitions ? transitions.leave(unit) : unit.parentNode?.removeChild(unit)

    return
  }

  const nodes = nodesOf(unit)
  const held = unit.held = document.createDocumentFragment()

  for (const node of nodes) {
    if (transitions?.has(node)) {
      transitions.leave(node)
      unit.nodes = nodes
    }
    else {
      held.appendChild(node)
    }
  }
}

// What a block shows after its first render plays its enter phase, the elements with a `transition` it starts with.
export function entered(unit: Unit | null): void {
  if (unit) {
    for (const node of nodesOf(unit))
      transitions?.enter(node)
  }
}

export function animated(unit: Unit | null): boolean {
  return unit !== null && transitions !== undefined && nodesOf(unit).some(transitions.has)
}

// The units `render` claims from the region's server markup; one a client-only component built afresh goes in where the server left its part empty, before the unit claimed after it.
function claimUnits(region: Region, render: () => unknown): Unit[] {
  const claimed = region.claim(() => units(render()))
  let before = region.end

  for (let index = claimed.length - 1; index >= 0; index--) {
    const unit = claimed[index]!

    if (firstOf(unit).parentNode !== region.parent)
      region.insert(unit, before)

    before = firstOf(unit)
  }

  return claimed
}

export function firstOf(unit: Unit): Node {
  return unit instanceof Range ? unit.first : unit
}

export function lastOf(unit: Unit): Node {
  return unit instanceof Range ? unit.last : unit
}

export function rowUnit(made: Unit[]): Unit | null {
  if (made.length === 0)
    return null

  return made.length === 1 ? made[0]! : new Range(firstOf(made[0]!), lastOf(made.at(-1)!))
}

// Where the units about to be made go, noted by a dynamic part of a page in French, so a text inside code is left as it is.
let target: Node | undefined

// The value, once `parent` is noted as where its units go.
export function within<T>(parent: Node, value: T): T {
  target = parent

  return value
}

// `add` noting the same parent before each part, as a function child rendering a part of its own in between would change it.
function keepingParent<T>(add: (part: T) => void): (part: T) => void {
  const parent = target

  return (part) => {
    target = parent
    add(part)
  }
}

// The units a value renders to, read by `eachChild`: a text node for its text, a node or a range as it is.
export function units(value: unknown): Unit[] {
  const out: Unit[] = []

  const add = (part: string | object) => {
    if (typeof part === 'string') {
      out.push(claim ? claimText(part) : document.createTextNode(typeof KAY_FRENCH === 'undefined' ? part : frenchText(part, target)))
    }
    else if (part instanceof Range) {
      out.push(part)
    }
    else if (part instanceof Node) {
      // Already in place, as a static slot's nodes are: claimed as they are.
      if (claim?.next === part)
        claim.next = part.nextSibling

      const { firstChild, lastChild } = part

      if (part.nodeType !== 11)
        out.push(part)
      else if (firstChild && lastChild)
        out.push(firstChild === lastChild ? firstChild : new Range(firstChild, lastChild))
    }
  }

  eachChild(value, typeof KAY_FRENCH === 'undefined' ? add : keepingParent(add))

  return out
}

// Where the focused element sits among the nodes of `list`: the index of its top node, then of each child down to it.
function focusedIn(list: Unit[]): { element: Element, path: number[] } | undefined {
  const element = typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? null : document.activeElement

  if (!element || element === document.body)
    return undefined

  const top = list.flatMap(nodesOf)
  const path: number[] = []

  for (let node: Node = element; node.parentNode; node = node.parentNode) {
    const index = top.indexOf(node)

    if (index >= 0)
      return { element, path: [index, ...path] }

    path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node))
  }

  return undefined
}

// In development, a dynamic part drawn again with the same element in place of the focused one: the expression read something that changed, and whoever was typing in it lost focus.
function warnRedrawn(focused: { element: Element, path: number[] }, list: Unit[], fn: () => unknown): void {
  let node: Node | undefined = list.flatMap(nodesOf)[focused.path[0]!]

  for (const index of focused.path.slice(1))
    node = node?.childNodes[index]

  if (!(node instanceof Element) || node === focused.element || node.tagName !== focused.element.tagName)
    return

  console.warn(`[kay] this expression ran again and drew a new <${node.localName}> in place of the focused one, which lost focus: it read something that changed, such as a loop row's item, or a list built again. Read only what it draws from, or call what draws in untrack().\n${String(fn)}`, node)
}

// Renders what `fn` returns into a dynamic part, again whenever what it read changes; `reactive` false renders it once, as a component call does.
export function insert(element: Node | null, start: Node | null, end: Node | null, fn: () => unknown, reactive = true): void {
  const region = new Region(element, start, end)
  let current: Unit[] = []

  const update = (value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number') {
      const data = typeof KAY_FRENCH === 'undefined' ? String(value) : frenchText(String(value), region.parent)

      // Text replacing text keeps its node.
      if (current.length === 1 && (current[0] as Node).nodeType === 3) {
        if ((current[0] as Text).data !== data)
          (current[0] as Text).data = data

        return
      }

      // The first text of an element it is the only content of.
      if (current.length === 0 && element) {
        element.textContent = data
        current = element.firstChild ? [element.firstChild] : []

        return
      }
    }

    const next = units(typeof KAY_FRENCH === 'undefined' ? value : within(region.parent, value))

    if (next.length === current.length && next.every((unit, index) => unit === current[index]))
      return

    const focused = process.env.NODE_ENV === 'production' ? undefined : focusedIn(current)
    const kept = new Set(next)

    for (const unit of current) {
      if (!kept.has(unit))
        removeUnit(unit)
    }

    // A unit back before its leave phase ended is still in the document; its enter phase ends that leave.
    if (transitions && transitions.leaving.size > 0)
      transitions.back(next.flatMap(nodesOf))

    // Each unit goes before the first node not yet placed, unless already there, so a kept unit is not moved.
    let at = region.start ? region.start.nextSibling : region.element!.firstChild

    for (const unit of next) {
      // The cursor only lands on a unit's first node or a node playing its leave phase, one that is no unit of `next` now, which stays between the kept units until it ends.
      while (at && transitions?.leaving.has(at))
        at = at.nextSibling

      if (isStale(unit) || firstOf(unit) !== at)
        region.insert(unit, at ?? region.end)

      at = lastOf(unit).nextSibling
    }

    current = next

    // Tested again, so the build drops the warning with the call.
    if (process.env.NODE_ENV !== 'production' && focused)
      warnRedrawn(focused, next, fn)
  }

  const first = () => {
    if (claim)
      current = claimUnits(region, fn)
    else
      update(fn())
  }

  if (!reactive) {
    untrack(first)

    return
  }

  let started = false

  renderEffect(() => {
    if (!started) {
      started = true
      first()
    }
    else {
      update(fn())
    }
  })
}

// What a block shows in its region, the root it built that under when it owns one, and whether it rendered before, so what it shows next plays its enter phase.
export interface Block {
  region: Region
  units: Unit[]
  dispose: (() => void) | undefined
  rendered: boolean
}

export function blockIn(region: Region): Block {
  return { region, units: [], dispose: undefined, rendered: false }
}

// Shows what `render` returns in place of what the block showed, claimed instead when hydrating; `owned` builds it under a root of its own, disposed when the block shows something else.
export function swap(block: Block, render: () => unknown, owned = false): void {
  const entering = block.rendered

  release(block)
  block.units = owned
    ? root((dispose) => {
      block.dispose = dispose

      return show(block.region, block.units, render, entering)
    })
    : show(block.region, block.units, render, entering)
  block.rendered = true
}

export function release(block: Block): void {
  block.dispose?.()
  block.dispose = undefined
}

// Swaps the units a region holds for the ones `render` builds, claimed instead when hydrating; `entering` plays the enter phase of what it shows.
function show(region: Region, previous: Unit[], render: () => unknown, entering: boolean): Unit[] {
  if (claim)
    return claimUnits(region, render)

  for (const unit of previous)
    removeUnit(unit)

  const next = units(typeof KAY_FRENCH === 'undefined' ? render() : within(region.parent, render()))

  for (const unit of next)
    region.insert(unit)

  if (entering) {
    for (const unit of next)
      entered(unit)
  }

  return next
}

// An `if` chain: the first branch whose test passes renders, built again only when another branch takes over; a branch naming its value reads it through a function.
export function branches(element: Node | null, start: Node | null, end: Node | null, list: [test: (() => unknown) | null, render: (value: () => unknown) => unknown][]): void {
  const block = blockIn(new Region(element, start, end))
  const chosen = memo<[number, unknown]>(() => {
    for (const [index, [test]] of list.entries()) {
      const value = test ? test() : true

      if (Boolean(value) !== false)
        return [index, value]
    }

    return [-1, undefined]
  }, { equals: (previous, next) => previous[0] === next[0] && previous[1] === next[1] })
  const index = memo(() => chosen()[0])
  const value = () => chosen()[1]

  renderEffect(() => {
    const selected = index()

    untrack(() => unrecorded(() => swap(block, () => selected < 0 ? null : list[selected]![1](value))))
  })
}

// The `if` chain of a template naming no value: one memo of the branch number, so a test changing within the same branch builds nothing.
export function choose(element: Node | null, start: Node | null, end: Node | null, list: [test: (() => unknown) | null, render: () => unknown][]): void {
  const block = blockIn(new Region(element, start, end))
  const index = memo(() => {
    for (let at = 0; at < list.length; at++) {
      const test = list[at]![0]

      if (!test || Boolean(test()))
        return at
    }

    return -1
  })

  renderEffect(() => {
    const selected = index()

    untrack(() => unrecorded(() => swap(block, () => selected < 0 ? null : list[selected]![1]())))
  })
}

// The island a node sits in, named in what an error report says.
export function islandOf(node: Node): string | undefined {
  return (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(ISLAND)?.dataset.component
}

// ---- components

// Calls a component without the caller depending on what it reads as it builds itself.
export function component<P>(fn: (props: P) => unknown, props: P): unknown {
  return untrack(() => scope(() => fn(props)))
}

export function createElement(tag: string): Element {
  const element = document.createElement(tag)

  return element instanceof HTMLUnknownElement && !tag.includes('-') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : element
}

// ---- attributes and events

// A link's href goes to the page's locale's copy, as the server writes it, unless `written`: the link carries `hreflang`. An ARIA state takes a boolean as `"true"` or `"false"`.
export function attribute(element: Element, name: string, value: unknown, written = false): void {
  const given = attributeValue(name, value)

  if (given === false)
    element.removeAttribute(name)
  else if (given === true)
    element.setAttribute(name, '')
  else
    element.setAttribute(name, safeUrl(name, rebasedAttribute(name, name === 'href' && !written && element.localName === 'a' ? localizeHref(given) : given)))
}

let keepsSameTab: boolean | undefined

export function leavesInBrowser(href: unknown): boolean {
  keepsSameTab ??= browserKeepsSameTab()

  return !keepsSameTab && leavesSite(href, location.origin)
}

// A link leaving the site opens in a new tab, as the server writes it: `target="_blank" rel="noopener"` follow the `href`, `ownRel` for a link writing its own `rel`. Returns the href, for the effect setting it.
export function outside<T>(element: Element, href: T, ownRel = false): T {
  if (leavesInBrowser(href)) {
    element.setAttribute('target', '_blank')
    element.setAttribute('data-new-tab', '')

    if (!ownRel)
      element.setAttribute('rel', 'noopener')
  }
  else {
    element.removeAttribute('target')
    element.removeAttribute('data-new-tab')

    if (!ownRel)
      element.removeAttribute('rel')
  }

  return href
}

// A property where the element has one, such as an input's `value`; an attribute otherwise.
export function property(element: Element, name: string, value: unknown, written = false): void {
  // Markup the island cannot draw yet, such as Markdown whose renderer is still loading, leaves what the server wrote.
  if (claim && name === 'innerHTML' && isHeldMarkup(value))
    return

  // The server wrote this value, and what the person typed, ticked or opened since stays for the replayed event to read.
  if (claim && (name === 'value' || name === 'checked' || name === 'open')) {
    // A toggle or a close does not bubble to the document, so one made before hydrating is never replayed: the element tells its own listener once the island is in.
    if (name === 'open' && (element as HTMLDetailsElement).open !== Boolean(value))
      queueMicrotask(() => element.dispatchEvent(new Event(element.localName === 'dialog' ? 'close' : 'toggle')))

    return
  }

  // Dropping the `open` of a modal dialog would leave it in the top layer, inert page and backdrop included.
  if (name === 'open' && Boolean(value) === false && element.localName === 'dialog' && (element as HTMLDialogElement).open)
    (element as HTMLDialogElement).close()
  else if (VOID_PROPERTIES.has(name) && name in element)
    (element as ElementRecord)[name] = name === 'value' ? (value ?? '') : value
  else if (CONTENT_PROPERTIES.has(name))
    (element as ElementRecord)[name] = value ?? ''
  else
    attribute(element, name, value, written)
}

// A class bound to an expression is never in the template, so a fresh element starts with none; a claimed one has the server's, set again.
export function setClass(element: Element, value: unknown): void {
  const name = classText(value)
  const record = element as Element & { _$c?: string }

  if (record._$c === name || (record._$c === undefined && name === '' && !claim)) {
    record._$c = name

    return
  }

  record._$c = name

  if (name === '')
    element.removeAttribute('class')
  else
    element.setAttribute('class', name)
}

export function setStyle(element: Element, value: unknown, props?: readonly (readonly [string, unknown])[]): void {
  const text = styleText(value, props)

  if (text === '')
    element.removeAttribute('style')
  else
    element.setAttribute('style', text)
}

// Set by form-hold when an island loads it, so a `submit` handler given through a spread is held too.
export const submits: { listen?: typeof listen } = {}

// `onClick` listens for `click`: through the document's one listener for the common events, on the element for the others. The handler is kept on the element with the owner it was bound in, so what it starts, such as a stream an action answers with, ends with that island.
export function listen(element: Element, name: string, handler: (event: Event) => void): void {
  const type = name.slice(2).toLowerCase()

  ;(element as ElementRecord)[`$$${type}`] = handler
  ;(element as ElementRecord).$o = activeOwner

  if (!DELEGATED.test(type)) {
    element.addEventListener(type, fire)

    return
  }

  const types = (document as DelegatingDocument)._$kt ??= new Set()

  if (!types.has(type)) {
    types.add(type)
    document.addEventListener(type, dispatch)
  }
}

export function unlisten(element: Element, name: string): void {
  const type = name.slice(2).toLowerCase()

  ;(element as ElementRecord)[`$$${type}`] = undefined
  element.removeEventListener(type, fire)
}

function fire(this: ElementRecord, event: Event): void {
  runWithOwner(this.$o as Owner | undefined, () => (this[`$$${event.type}`] as (event: Event) => void)(event))
}

// Calls the handlers from the event's target up, each seeing its own element as `currentTarget`, until one stops propagation.
export function dispatch(event: Event): void {
  const key = `$$${event.type}`
  let node = (event.composedPath?.()[0] ?? event.target) as Node | null

  while (node) {
    const handler = (node as unknown as Record<string, unknown>)[key] as ((event: Event) => void) | undefined

    if (handler && !(node as unknown as { disabled?: boolean }).disabled) {
      // Defined only where a handler runs, as most events on a page reach none.
      Object.defineProperty(event, 'currentTarget', { configurable: true, get: () => node ?? document })
      fire.call(node as unknown as ElementRecord, event)

      if (event.cancelBubble)
        return
    }

    node = node.parentNode ?? (node as unknown as ShadowRoot).host ?? null
  }
}

// A function ref may return a cleanup, which runs when the element's owner is disposed, so a reusable behaviour (a tooltip, an observer) lets go of what it attached.
export function ref(element: Element, target: unknown): void {
  const cleanup = typeof target === 'function' ? (target as (element: Element) => unknown)(element) : undefined

  if (typeof cleanup === 'function')
    onCleanup(cleanup as () => void)
}

// ---- mounting

// Renders `render`'s result as `container`'s content; returns what removes it again.
export function render(fn: () => unknown, container: Element): () => void {
  return root((dispose) => {
    insert(container, null, null, fn, false)

    return () => {
      dispose()
      container.textContent = ''
    }
  })
}

// Renders what `fn` returns at the end of `container`, between two markers of its own; returns what removes those nodes again and leaves the rest of `container` as it was.
export function renderAppended(fn: () => unknown, container: Element): () => void {
  const start = document.createComment('')
  const end = document.createComment('')

  container.append(start, end)

  return root((dispose) => {
    insert(null, start, end, fn, false)

    return () => {
      dispose()

      const parent = start.parentNode

      // The app may have emptied or rebuilt the element already.
      if (!parent)
        return

      if (end.parentNode === parent)
        new Region(null, start, end).clear()

      start.remove()
      end.remove()
    }
  })
}
