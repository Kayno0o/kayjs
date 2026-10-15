// What islands run on in the browser: DOM built from templates, kept in step with signals, and the server's markup claimed in place when an island hydrates.
// A dynamic part sits between `<!--[-->` and `<!--]-->` comments unless it is the only content of its element; hydration walks the server's nodes in the order the generated code asks for them.

import { rebasedAttribute } from './base'
import { imageSource } from './image'
import { FAILED, ISLAND, PART_END, PART_START } from './markers'
import { catchError, createSignal, getOwner, hydrationEnded, hydrationStarted, memo, onCleanup, renderEffect, reportError, root, runWithOwner, scope, unrecorded, untrack } from './reactive'
import { freshPrefix, withIds } from './uid'
import { safeUrl } from './url'
import { attributeName, attributeValue, classText, eachChild, elementName, handlerName, merge, spreadAttributes, styleText } from './values'

export { holdSubmits, listenSubmit } from './form-hold'
export { renderEffect as effect, memo, untrack } from './reactive'
export { transition } from './transition'
export { componentClass, merge, omit, spreadAttributes } from './values'

// Several sibling nodes rendered as one: a block or a component returning more than one node. Its first and last nodes stay in place while what sits between changes.
export class Range {
  constructor(readonly first: Node, readonly last: Node) {}
}

// What a template, a block or a component gives back.
export type Unit = Node | Range

// Where hydration claims its next node: inside `parent`, starting at `next`.
interface Claim {
  parent: Node
  next: Node | null
}

export class HydrationMismatch extends Error {
  override name = 'HydrationMismatch'
}

const TAG_END = /[\s>]/
// What `img(src={hero})` sets, its size left alone when the template gives one.
const IMAGE_SOURCE = ['src', 'srcset', 'sizes']
const SIZED_IMAGE = ['src', 'srcset', 'sizes', 'width', 'height']
const VOID_PROPERTIES = new Set(['value', 'checked', 'selected', 'muted', 'indeterminate'])
const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText'])
// Events handled by one listener on the document, as most pages bind them on many elements at once.
const DELEGATED = new Set(['beforeinput', 'click', 'dblclick', 'contextmenu', 'focusin', 'focusout', 'input', 'keydown', 'keyup', 'mousedown', 'mousemove', 'mouseout', 'mouseover', 'mouseup', 'pointerdown', 'pointermove', 'pointerout', 'pointerover', 'pointerup', 'touchend', 'touchmove', 'touchstart'])

// The events the document already has a listener for, kept on the document so a second copy of this runtime on the page adds none of its own.
interface DelegatingDocument extends Document {
  _$kt?: Set<string>
}

let claim: Claim | undefined

// What plays an element's transition, set by the first one a template sets, so a page whose islands set none ships none of its code.
export interface Transitions {
  has: (node: Node) => node is Element
  enter: (element: Element) => void
  leave: (element: Element) => void
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

function claimNode(): Node {
  const node = claim!.next

  if (!node)
    throw new HydrationMismatch('the server markup ended before the island did')

  claim!.next = node.nextSibling

  return node
}

// Claims a text node holding `data`, making one when the server wrote nothing, as for an empty string.
function claimText(data: string): Text {
  const next = claim!.next

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

  throw new HydrationMismatch('a dynamic part of the server markup has no end')
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
        throw new HydrationMismatch(`expected <${tag.toLowerCase()}> where the server markup holds ${claimed.nodeName.toLowerCase()}`)

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
    parent.appendChild(document.createTextNode(data))
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
      throw new HydrationMismatch(`expected the start of a dynamic part where the server markup holds ${start.nodeName}`)

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
class Region {
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

function insertUnit(parent: Node, unit: Unit, before: Node | null): void {
  // Before its own first node: already in place, and moving its nodes one by one before that one would put them in front of it.
  if (before === firstOf(unit))
    return

  if (!(unit instanceof Range)) {
    parent.insertBefore(unit, before)

    return
  }

  let node: Node | null = unit.first

  while (node) {
    const next: Node | null = node === unit.last ? null : node.nextSibling

    parent.insertBefore(node, before)
    node = next
  }
}

// The nodes a unit is made of, in order.
function nodesOf(unit: Unit): Node[] {
  if (!(unit instanceof Range))
    return [unit]

  const nodes: Node[] = []

  for (let node: Node | null = unit.first; node; node = node === unit.last ? null : node.nextSibling)
    nodes.push(node)

  return nodes
}

// An element with a `transition` plays its leave phase first.
function removeUnit(unit: Unit): void {
  for (const node of nodesOf(unit)) {
    if (transitions?.has(node))
      transitions.leave(node)
    else
      node.parentNode?.removeChild(node)
  }
}

// What a block shows after its first render plays its enter phase, the elements with a `transition` it starts with.
function entered(unit: Unit | null): void {
  if (!unit || !transitions)
    return

  for (const node of nodesOf(unit)) {
    if (transitions.has(node))
      transitions.enter(node)
  }
}

function animated(unit: Unit | null): boolean {
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

function firstOf(unit: Unit): Node {
  return unit instanceof Range ? unit.first : unit
}

function lastOf(unit: Unit): Node {
  return unit instanceof Range ? unit.last : unit
}

// The units a value renders to, read by `eachChild`: a text node for its text, a node or a range as it is.
function units(value: unknown): Unit[] {
  const out: Unit[] = []

  eachChild(value, (part) => {
    if (typeof part === 'string') {
      out.push(claim ? claimText(part) : document.createTextNode(part))
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
  })

  return out
}

// Where the focused element sits among the nodes of `list`: the index of its top node, then of each child down to it.
function focusedIn(list: Unit[]): { element: Element, path: number[] } | undefined {
  const element = typeof document === 'undefined' ? null : document.activeElement

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
      const data = String(value)

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

    const next = units(value)

    if (next.length === current.length && next.every((unit, index) => unit === current[index]))
      return

    const focused = process.env.NODE_ENV === 'production' ? undefined : focusedIn(current)
    const kept = new Set(next)

    for (const unit of current) {
      if (!kept.has(unit))
        removeUnit(unit)
    }

    // Each unit goes before the first node not yet placed, unless already there, so a kept unit is not moved.
    let at = region.start ? region.start.nextSibling : region.element!.firstChild

    for (const unit of next) {
      // A node playing its leave phase stays between the kept units until it ends.
      while (at && firstOf(unit) !== at && transitions?.has(at))
        at = at.nextSibling

      if (firstOf(unit) === at)
        at = lastOf(unit).nextSibling
      else
        region.insert(unit, at ?? region.end)
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
interface Block {
  region: Region
  units: Unit[]
  dispose: (() => void) | undefined
  rendered: boolean
}

function blockIn(region: Region): Block {
  return { region, units: [], dispose: undefined, rendered: false }
}

// Shows what `render` returns in place of what the block showed, claimed instead when hydrating; `owned` builds it under a root of its own, disposed when the block shows something else.
function swap(block: Block, render: () => unknown, owned = false): void {
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

function release(block: Block): void {
  block.dispose?.()
  block.dispose = undefined
}

// Swaps the units a region holds for the ones `render` builds, claimed instead when hydrating; `entering` plays the enter phase of what it shows.
function show(region: Region, previous: Unit[], render: () => unknown, entering: boolean): Unit[] {
  if (claim)
    return claimUnits(region, render)

  for (const unit of previous)
    removeUnit(unit)

  const next = units(render())

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

interface Row {
  key: unknown
  unit: Unit | null
  setItem: (item: unknown) => void
  setIndex: ((index: number) => void) | undefined
  dispose: () => void
}

// The key of a row whose `for` names none: the item's `id` when it has one, else the item itself.
export function rowKey(item: unknown): unknown {
  return typeof item === 'object' && item !== null && 'id' in item ? item.id : item
}

// A `for`: one row per item, matched to the rows of the last render by key, or by position when `keyed` is false.
// A row reads its item through a function, and its index through one too when keyed, so a row kept across renders follows the new values.
export function loop<T>(element: Node | null, start: Node | null, end: Node | null, each: () => readonly T[] | null | undefined | false, key: ((item: T) => unknown) | false, render: (item: () => T, index: (() => number) | number) => unknown, fallback?: () => unknown): void {
  const region = new Region(element, start, end)
  // The fallback, and whether the loop rendered before, so the rows it makes then play their enter phase.
  const empty = blockIn(region)
  // The rows a run made, which enter once it is done.
  const built: Row[] = []
  let rows: Row[] = []

  onCleanup(() => {
    for (const row of rows)
      row.dispose()

    release(empty)
  })

  const makeRow = (item: T, index: number, rowKey: unknown): Row => {
    const row = unrecorded(() => root((dispose): Row => {
      const [readItem, setItem] = createSignal(item)
      let setIndex: ((index: number) => void) | undefined
      let readIndex: (() => number) | number = index

      // Made on the first read, as most rows never read their index.
      if (key !== false) {
        let signal: ReturnType<typeof createSignal<number>> | undefined

        readIndex = () => (signal ??= createSignal(index))[0]()
        setIndex = (next) => {
          index = next
          signal?.[1](next)
        }
      }

      const value = render(readItem, readIndex)
      const made = units(value)

      return { key: rowKey, unit: made.length === 0 ? null : made.length === 1 ? made[0]! : new Range(firstOf(made[0]!), lastOf(made.at(-1)!)), setItem: setItem as (item: unknown) => void, setIndex, dispose }
    }))

    built.push(row)

    return row
  }

  renderEffect(() => {
    const items = each()
    const list = items === false || items == null ? [] : items

    untrack(() => {
      const entering = empty.rendered

      // A run that threw part way leaves the rows it made and never kept.
      for (const row of built) {
        if (!rows.includes(row))
          removeRow(row)
      }

      built.length = 0
      rows = claim && !entering ? region.claim(() => list.map((item, index) => makeRow(item, index, key === false ? index : key(item)))) : reconcileRows(region, rows, list, key, makeRow)

      if (entering) {
        for (const row of built)
          entered(row.unit)
      }

      built.length = 0

      // Owning a root of its own, the fallback shows while it has one.
      if (list.length === 0 && !empty.dispose && fallback)
        swap(empty, fallback, true)
      else if (list.length > 0 && empty.dispose)
        swap(empty, () => null)

      empty.rendered = true
    })
  })
}

function reconcileRows<T>(region: Region, previous: Row[], list: readonly T[], key: ((item: T) => unknown) | false, makeRow: (item: T, index: number, key: unknown) => Row): Row[] {
  if (list.length === 0) {
    removeRows(region, previous, true)

    return []
  }

  return key === false ? positionalRows(region, previous, list, makeRow) : keyedRows(region, previous, list, key, makeRow)
}

// By position: the first rows take the new items, the rest come and go at the end.
function positionalRows<T>(region: Region, previous: Row[], list: readonly T[], makeRow: (item: T, index: number, key: unknown) => Row): Row[] {
  const next: Row[] = []

  for (const [index, item] of list.entries()) {
    const row = previous[index]

    if (row) {
      row.setItem(item)
      next.push(row)
    }
    else {
      const made = makeRow(item, index, index)

      if (made.unit)
        region.insert(made.unit)

      next.push(made)
    }
  }

  removeRows(region, previous.slice(list.length), false)

  return next
}

function keyedRows<T>(region: Region, previous: Row[], list: readonly T[], key: (item: T) => unknown, makeRow: (item: T, index: number, key: unknown) => Row): Row[] {
  const keys = list.map(key)
  const update = (row: Row, index: number) => {
    row.setItem(list[index])
    row.setIndex?.(index)
  }
  let start = 0
  let oldEnd = previous.length
  let newEnd = list.length

  // The rows keeping their place at either end only take their new item and index.
  while (start < oldEnd && start < newEnd && previous[start]!.key === keys[start]) {
    update(previous[start]!, start)
    start++
  }

  while (start < oldEnd && start < newEnd && previous[oldEnd - 1]!.key === keys[newEnd - 1])
    update(previous[--oldEnd]!, --newEnd)

  if (start === oldEnd && start === newEnd)
    return previous

  const after = firstNode(previous, oldEnd) ?? region.end
  const byKey = new Map<unknown, Row>()

  for (let index = start; index < oldEnd; index++) {
    const row = previous[index]!
    const twin = byKey.get(row.key)

    // Of two rows under one key, only the last can be matched: the other goes.
    if (twin)
      removeRow(twin)

    byKey.set(row.key, row)
  }

  const middle: Row[] = []
  let added = 0

  for (let index = start; index < newEnd; index++) {
    const row = byKey.get(keys[index])

    if (row) {
      byKey.delete(keys[index])
      update(row, index)
      middle.push(row)
    }
    else {
      middle.push(makeRow(list[index]!, index, keys[index]))
      added++
    }
  }

  removeRows(region, [...byKey.values()], byKey.size === previous.length)

  // Only new rows between what stays: one insertion.
  if (added === middle.length) {
    const holder = document.createDocumentFragment()

    for (const row of middle) {
      if (row.unit)
        insertUnit(holder, row.unit, null)
    }

    region.parent.insertBefore(holder, after)
  }
  else {
    const kept = new Set(middle)

    moveRows(region.parent, previous.slice(start, oldEnd).filter(row => kept.has(row)), middle, after)
  }

  return [...previous.slice(0, start), ...middle, ...previous.slice(oldEnd)]
}

// Takes rows out; when they are all the region holds, its whole content is cleared at once, unless a row plays its leave phase, which that would cut.
function removeRows(region: Region, rows: Row[], all: boolean): void {
  if (all && rows.length > 0 && !region.start && !rows.some(row => animated(row.unit))) {
    for (const row of rows)
      row.dispose()

    region.clear()

    return
  }

  for (const row of rows)
    removeRow(row)
}

function removeRow(row: Row): void {
  row.dispose()

  if (row.unit)
    removeUnit(row.unit)
}

// The first node of the rows from `index` on, where what is inserted before them goes.
function firstNode(rows: Row[], index: number): Node | null {
  for (let at = index; at < rows.length; at++) {
    const unit = rows[at]!.unit

    if (unit)
      return firstOf(unit)
  }

  return null
}

// Puts the rows in their new order with as few moves as it can, as udomdiff does: the common start and end stay, a swap is two moves, and a row out of place moves before the one that follows it.
function moveRows(parent: Node, kept: Row[], next: Row[], after: Node | null): void {
  const a = kept.filter(row => row.unit)
  const b = next.filter(row => row.unit)
  let aStart = 0
  let bStart = 0
  let aEnd = a.length
  let bEnd = b.length
  let positions: Map<Row, number> | undefined

  const nextAfter = (row: Row) => lastOf(row.unit!).nextSibling

  while (aStart < aEnd || bStart < bEnd) {
    if (aStart < aEnd && bStart < bEnd && a[aStart] === b[bStart]) {
      aStart++
      bStart++

      continue
    }

    while (aStart < aEnd && bStart < bEnd && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--
      bEnd--
    }

    if (aEnd === aStart) {
      const before = bEnd < b.length ? firstOf(b[bEnd]!.unit!) : after

      while (bStart < bEnd)
        insertUnit(parent, b[bStart++]!.unit!, before)
    }
    // Every row left in `a` is kept, so once `b` is placed they already are too.
    else if (bEnd === bStart) {
      break
    }
    else if (a[aStart] === b[bEnd - 1] && b[bStart] === a[aEnd - 1]) {
      const before = nextAfter(a[--aEnd]!)

      insertUnit(parent, b[bStart++]!.unit!, nextAfter(a[aStart++]!))
      insertUnit(parent, b[--bEnd]!.unit!, before)
      a[aEnd] = b[bEnd]!
    }
    else {
      if (!positions) {
        positions = new Map()

        for (let index = bStart; index < bEnd; index++)
          positions.set(b[index]!, index)
      }

      const index = positions.get(a[aStart]!)

      if (index === undefined) {
        removeUnit(a[aStart++]!.unit!)

        continue
      }

      if (index <= bStart || index >= bEnd) {
        aStart++

        continue
      }

      let sequence = 1

      for (let i = aStart + 1; i < aEnd && i < bEnd; i++) {
        if (positions.get(a[i]!) !== index + sequence)
          break

        sequence++
      }

      if (sequence > index - bStart) {
        const before = firstOf(a[aStart]!.unit!)

        while (bStart < index)
          insertUnit(parent, b[bStart++]!.unit!, before)
      }
      // The row out of place stays where it is until its own turn moves it: taking a row of several nodes out would lose all but its first.
      else {
        insertUnit(parent, b[bStart++]!.unit!, firstOf(a[aStart++]!.unit!))
      }
    }
  }
}

// An `await` block: the pending block while the value is a promise, then the `then` or `catch` block once it settles; a plain value renders `then` at once.
export function awaited(element: Node | null, start: Node | null, end: Node | null, value: () => unknown, pending: (() => unknown) | undefined, ready: (value: unknown) => unknown, failed: ((error: unknown) => unknown) | undefined): void {
  const block = blockIn(new Region(element, start, end))
  let version = 0

  renderEffect(() => {
    const settled = value()
    const own = ++version

    untrack(() => {
      if (!(settled instanceof Promise)) {
        unrecorded(() => swap(block, () => ready(settled)))

        return
      }

      // Where the block was declared, for one landing later to read what was provided there.
      const parent = getOwner()

      // Gone before the promise settles, the block never lands.
      onCleanup(() => {
        version++
        release(block)
      })

      // The pending block and the block replacing it each own what they create, so landing disposes the pending one.
      unrecorded(() => swap(block, () => pending?.(), true))

      const land = (render: () => unknown) => {
        if (own === version)
          runWithOwner(parent, () => unrecorded(() => swap(block, render, true)))
      }

      // A `then` block that throws while rendering is not the promise failing, so it stays out of the catch.
      const settle = async () => {
        let result: unknown

        try {
          result = await settled
        }
        catch (error) {
          if (failed)
            land(() => failed(error))
          else
            console.error(error)

          return
        }

        land(() => ready(result))
      }

      void settle()
    })
  })
}

// A `try` block: its content under an owner catching what its effects throw later, or its `catch` block once it throws, the error reported either way.
export function attempt(element: Node | null, start: Node | null, end: Node | null, render: () => unknown, fallback: ((error: unknown) => unknown) | undefined): void {
  const region = new Region(element, start, end)

  // The server rendered the `catch` block: kept as it came, since the error it shows stayed on the server.
  if (claim && failedOnServer(region))
    return

  const block = blockIn(region)
  let failed = false
  let disposeContent: (() => void) | undefined
  const parent = getOwner()

  onCleanup(() => release(block))

  const fail = (error: unknown) => {
    reportError(error, islandOf(region.parent))

    if (failed)
      return

    failed = true
    disposeContent?.()
    // What the block built, or claimed before it threw, goes; the fallback is built afresh.
    region.clear()
    block.units = []

    if (fallback)
      runWithOwner(parent, () => unrecorded(() => fresh(() => swap(block, () => fallback(error), true))))
  }

  catchError((dispose) => {
    disposeContent = dispose

    try {
      swap(block, render)
    }
    catch (error) {
      // Markup the island would not claim is the island's to recover from, rendering it afresh, not the block's to fall back from.
      if (error instanceof HydrationMismatch)
        throw error

      fail(error)
    }
  }, fail)
}

// The island a node sits in, named in what an error report says.
function islandOf(node: Node): string | undefined {
  return (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(ISLAND)?.dataset.component
}

function failedOnServer(region: Region): boolean {
  const first = region.start ? region.start.nextSibling : region.element!.firstChild

  return first?.nodeType === 8 && (first as Comment).data === FAILED
}

// ---- components

// Calls a component without the caller depending on what it reads as it builds itself.
export function component<P>(fn: (props: P) => unknown, props: P): unknown {
  return untrack(() => scope(() => fn(props)))
}

// A component tag read off a prop or through a call: a string names an element, a function is the component.
export function dynamic(tag: unknown, props: Record<string, unknown>): unknown {
  if (typeof tag === 'function')
    return component(tag as (props: unknown) => unknown, props)

  if (typeof tag !== 'string')
    return null

  const element = claim ? claimNode() as Element : createElement(elementName(tag))

  spread(element, () => [spreadAttributes(props)], 'children' in props)

  return element
}

function createElement(tag: string): Element {
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

// An `img` source, with the variants, `sizes` and size of an imported image; a later source clears what an earlier one set.
export function image(element: Element, src: unknown, sized: boolean, sizes?: unknown): void {
  const props = imageSource(src, sized, sizes) as Record<string, unknown>

  for (const name of sized ? IMAGE_SOURCE : SIZED_IMAGE)
    attribute(element, name, props[name])
}

// A property where the element has one, such as an input's `value`; an attribute otherwise.
export function property(element: Element, name: string, value: unknown, written = false): void {
  // The server wrote this value, and what the person typed or ticked since stays for the replayed event to read.
  if (claim && (name === 'value' || name === 'checked'))
    return

  if (VOID_PROPERTIES.has(name) && name in element)
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

export function setStyle(element: Element, value: unknown): void {
  if (Boolean(value) === false)
    element.removeAttribute('style')
  else
    element.setAttribute('style', styleText(value))
}

// Set by form-hold when an island loads it, so a `submit` handler given through a spread is held too.
export const submits: { listen?: typeof listen, unlisten?: typeof unlisten } = {}

// `onClick` listens for `click`: through the document's one listener for the common events, on the element for the others.
export function listen(element: Element, name: string, handler: (event: Event) => void, replaced?: (event: Event) => void): void {
  const type = name.slice(2).toLowerCase()

  if (!DELEGATED.has(type)) {
    if (replaced)
      element.removeEventListener(type, replaced)

    element.addEventListener(type, handler)

    return
  }

  ;(element as ElementRecord)[`$$${type}`] = handler

  const types = (document as DelegatingDocument)._$kt ??= new Set()

  if (!types.has(type)) {
    types.add(type)
    document.addEventListener(type, dispatch)
  }
}

export function unlisten(element: Element, name: string, handler: (event: Event) => void): void {
  const type = name.slice(2).toLowerCase()

  if (DELEGATED.has(type))
    (element as ElementRecord)[`$$${type}`] = undefined
  else
    element.removeEventListener(type, handler)
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
      handler.call(node, event)

      if (event.cancelBubble)
        return
    }

    node = node.parentNode ?? (node as unknown as ShadowRoot).host ?? null
  }
}

export function ref(element: Element, target: unknown): void {
  if (typeof target === 'function')
    (target as (element: Element) => void)(element)
}

// Attributes and handlers from objects only known at render time; with `content`, a `children`, `innerHTML` or `textContent` among them sets the element's content.
export function spread(element: Element, sources: () => readonly object[], content = false): void {
  const set = new Map<string, unknown>()

  // Children render in a part of their own, so a change to another prop does not build them again.
  if (content)
    insert(element, null, null, () => merge(...sources()).children)

  renderEffect(() => {
    const props = merge(...sources())
    const seen = new Set<string>()

    for (const name of Object.keys(props)) {
      if (name === 'children' || !attributeName(name))
        continue

      const value = props[name]

      seen.add(name)

      if (set.get(name) === value)
        continue

      const previous = set.get(name)

      set.set(name, value)

      if (name === 'ref') {
        ref(element, value)
      }
      else if (handlerName(name) && typeof value === 'function') {
        (submits.listen ?? listen)(element, name, value as (event: Event) => void, previous as ((event: Event) => void) | undefined)
      }
      // A handler given as text runs as script, which the server never writes either.
      else if (handlerName(name)) {
        continue
      }
      else if (name === 'class') {
        setClass(element, value)
      }
      else if (name === 'style') {
        setStyle(element, value)
      }
      else {
        try {
          property(element, name, value, Object.hasOwn(props, 'hreflang'))
        }
        // A name the server writes but the browser refuses to set, such as `@click`.
        catch {}
      }
    }

    for (const [name, previous] of set) {
      if (seen.has(name))
        continue

      set.delete(name)

      if (handlerName(name) && typeof previous === 'function')
        (submits.unlisten ?? unlisten)(element, name, previous as (event: Event) => void)
      else if (name !== 'ref' && !handlerName(name))
        property(element, name, undefined)
    }
  })
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
