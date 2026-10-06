// What islands run on in the browser: DOM built from templates, kept in step with signals, and the server's markup claimed in place when an island hydrates.
// A dynamic part sits between `<!--[-->` and `<!--]-->` comments unless it is the only content of its element; hydration walks the server's nodes in the order the generated code asks for them.

import { flattenClasses } from './classes'
import { imageSource } from './image'
import { catchError, createSignal, getOwner, hydrationEnded, hydrationStarted, memo, onCleanup, renderEffect, reportError, root, runWithOwner, scope, unrecorded, untrack } from './reactive'
import { freshPrefix, withIds } from './uid'
import { safeUrl } from './url'

export { componentClass } from './classes'
export { renderEffect as effect } from './reactive'

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
const START = '['
const END = ']'
const VOID_PROPERTIES = new Set(['value', 'checked', 'selected', 'muted', 'indeterminate'])
const CONTENT_PROPERTIES = new Set(['innerHTML', 'textContent', 'innerText'])
// Events handled by one listener on the document, as most pages bind them on many elements at once.
const DELEGATED = new Set(['beforeinput', 'click', 'dblclick', 'contextmenu', 'focusin', 'focusout', 'input', 'keydown', 'keyup', 'mousedown', 'mousemove', 'mouseout', 'mouseover', 'mouseup', 'pointerdown', 'pointermove', 'pointerout', 'pointerover', 'pointerup', 'touchend', 'touchmove', 'touchstart'])

// The events the document already has a listener for, kept on the document so a second copy of this runtime on the page adds none of its own.
interface DelegatingDocument extends Document {
  _$kt?: Set<string>
}

let claim: Claim | undefined
// The comment `FAILED_MARKER` of kay/html holds.
const FAILED_MARKER_DATA = 'kay-failed'
const ISLAND_SLOT = 'slot[data-component]'

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

    if (data === START)
      depth++
    else if (data === END && depth-- === 0)
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

// The markers around a dynamic part of a block.
export function markers(parent: Node): [start: Node, end: Node] {
  if (claim) {
    const start = claimNode()

    if (start.nodeType !== 8 || (start as Comment).data !== START)
      throw new HydrationMismatch(`expected the start of a dynamic part where the server markup holds ${start.nodeName}`)

    const end = close(start)

    claim.next = end.nextSibling

    return [start, end]
  }

  const start = document.createComment(START)
  const end = document.createComment(END)

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

function removeUnit(unit: Unit): void {
  if (!(unit instanceof Range)) {
    unit.parentNode?.removeChild(unit)

    return
  }

  let node: Node | null = unit.first

  while (node) {
    const next: Node | null = node === unit.last ? null : node.nextSibling

    node.parentNode?.removeChild(node)
    node = next
  }
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

// The units a value renders to: text for strings and numbers, nothing for `null`, `undefined` and booleans, functions read for what they return.
function units(value: unknown, out: Unit[] = []): Unit[] {
  if (value == null || typeof value === 'boolean')
    return out

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    out.push(claim ? claimText(String(value)) : document.createTextNode(String(value)))

    return out
  }

  if (typeof value === 'function')
    return units((value as () => unknown)(), out)

  if (Array.isArray(value)) {
    for (const item of value)
      units(item, out)

    return out
  }

  if (value instanceof Range) {
    out.push(value)

    return out
  }

  if (value instanceof Node) {
    if (value.nodeType === 11) {
      const { firstChild, lastChild } = value

      if (firstChild && lastChild)
        out.push(firstChild === lastChild ? firstChild : new Range(firstChild, lastChild))
    }
    else {
      out.push(value)
    }
  }

  return out
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

    const kept = new Set(next)

    for (const unit of current) {
      if (!kept.has(unit))
        removeUnit(unit)
    }

    for (const unit of next)
      region.insert(unit)

    current = next
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

// Swaps the unit a dynamic part holds for the one `render` builds, claimed instead when hydrating.
function show(region: Region, previous: Unit[], render: () => unknown): Unit[] {
  if (claim)
    return claimUnits(region, render)

  for (const unit of previous)
    removeUnit(unit)

  const next = units(render())

  for (const unit of next)
    region.insert(unit)

  return next
}

// An `if` chain: the first branch whose test passes renders, built again only when another branch takes over; a branch naming its value reads it through a function.
export function branches(element: Node | null, start: Node | null, end: Node | null, list: [test: (() => unknown) | null, render: (value: () => unknown) => unknown][]): void {
  const region = new Region(element, start, end)
  const chosen = memo<[number, unknown]>(() => {
    for (const [index, [test]] of list.entries()) {
      const value = test ? test() : true

      if (value)
        return [index, value]
    }

    return [-1, undefined]
  }, { equals: (previous, next) => previous[0] === next[0] && previous[1] === next[1] })
  const index = memo(() => chosen()[0])
  const value = () => chosen()[1]
  let current: Unit[] = []

  renderEffect(() => {
    const selected = index()

    current = untrack(() => unrecorded(() => show(region, current, () => selected < 0 ? null : list[selected]![1](value))))
  })
}

interface Row {
  key: unknown
  unit: Unit | null
  setItem: (item: unknown) => void
  setIndex: ((index: number) => void) | undefined
  dispose: () => void
}

// A `for`: one row per item, matched to the rows of the last render by key, or by position when `keyed` is false.
// A row reads its item through a function, and its index through one too when keyed, so a row kept across renders follows the new values.
export function loop<T>(element: Node | null, start: Node | null, end: Node | null, each: () => readonly T[] | null | undefined | false, key: ((item: T) => unknown) | false, render: (item: () => T, index: (() => number) | number) => unknown, fallback?: () => unknown): void {
  const region = new Region(element, start, end)
  let rows: Row[] = []
  let fallbackUnits: Unit[] | undefined
  let disposeFallback: (() => void) | undefined

  onCleanup(() => {
    for (const row of rows)
      row.dispose()

    disposeFallback?.()
  })

  const makeRow = (item: T, index: number, rowKey: unknown): Row => unrecorded(() => root((dispose) => {
    const [readItem, setItem] = createSignal(item)
    let setIndex: ((index: number) => void) | undefined
    let readIndex: (() => number) | number = index

    if (key !== false) {
      const [read, write] = createSignal(index)

      readIndex = read
      setIndex = write
    }

    const value = render(readItem, readIndex)
    const made = units(value)

    return { key: rowKey, unit: made.length === 0 ? null : made.length === 1 ? made[0]! : new Range(firstOf(made[0]!), lastOf(made.at(-1)!)), setItem: setItem as (item: unknown) => void, setIndex, dispose }
  }))

  const showFallback = (on: boolean) => {
    if (on && !fallbackUnits && fallback) {
      fallbackUnits = root((dispose) => {
        disposeFallback = dispose

        return show(region, [], fallback)
      })
    }
    else if (!on && fallbackUnits) {
      for (const unit of fallbackUnits)
        removeUnit(unit)

      disposeFallback?.()
      fallbackUnits = undefined
      disposeFallback = undefined
    }
  }

  let started = false

  renderEffect(() => {
    const list = each() || []

    untrack(() => {
      if (!started) {
        started = true

        if (claim) {
          rows = region.claim(() => list.map((item, index) => makeRow(item, index, key === false ? index : key(item))))
          showFallback(list.length === 0)

          return
        }
      }

      rows = reconcileRows(region, rows, list, key, makeRow)
      showFallback(list.length === 0)
    })
  })
}

function reconcileRows<T>(region: Region, previous: Row[], list: readonly T[], key: ((item: T) => unknown) | false, makeRow: (item: T, index: number, key: unknown) => Row): Row[] {
  if (list.length === 0) {
    if (previous.length > 0) {
      for (const row of previous)
        row.dispose()

      if (region.start) {
        for (const row of previous) {
          if (row.unit)
            removeUnit(row.unit)
        }
      }
      else {
        region.clear()
      }
    }

    return []
  }

  // By position: the first rows take the new items, the rest come and go at the end.
  if (key === false) {
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

    for (const row of previous.slice(list.length)) {
      row.dispose()

      if (row.unit)
        removeUnit(row.unit)
    }

    return next
  }

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
  let fresh = 0

  for (let index = start; index < newEnd; index++) {
    const row = byKey.get(keys[index])

    if (row) {
      byKey.delete(keys[index])
      update(row, index)
      middle.push(row)
    }
    else {
      middle.push(makeRow(list[index]!, index, keys[index]))
      fresh++
    }
  }

  // Every old row goes: the whole content is cleared at once.
  if (byKey.size === previous.length && !region.start) {
    for (const row of previous)
      row.dispose()

    region.clear()
    byKey.clear()
  }

  for (const row of byKey.values())
    removeRow(row)

  // Only new rows between what stays: one insertion.
  if (fresh === middle.length) {
    const holder = document.createDocumentFragment()

    for (const row of middle) {
      if (row.unit)
        insertUnit(holder, row.unit, null)
    }

    region.parent.insertBefore(holder, after)
  }
  else {
    const placed = new Set(middle)

    moveRows(region.parent, previous.slice(start, oldEnd).filter(row => placed.has(row)), middle, after)
  }

  return [...previous.slice(0, start), ...middle, ...previous.slice(oldEnd)]
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
  const region = new Region(element, start, end)
  let current: Unit[] = []
  let version = 0

  renderEffect(() => {
    const settled = value()
    const own = ++version

    untrack(() => {
      if (!(settled instanceof Promise)) {
        current = unrecorded(() => show(region, current, () => ready(settled)))

        return
      }

      // The pending block and the block replacing it each own what they create, so landing disposes the pending one.
      let dispose: (() => void) | undefined
      // Where the block was declared, for one landing later to read what was provided there.
      const parent = getOwner()

      // Gone before the promise settles, the block never lands.
      onCleanup(() => {
        version++
        dispose?.()
      })

      const block = (render: () => unknown) => root((disposeBlock) => {
        dispose?.()
        dispose = disposeBlock
        current = unrecorded(() => show(region, current, render))
      })

      block(() => pending?.())

      const land = (render: () => unknown) => {
        if (own === version)
          runWithOwner(parent, () => block(render))
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

  let current: Unit[] = []
  let failed = false
  let disposeBlock: (() => void) | undefined
  let disposeFallback: (() => void) | undefined
  const parent = getOwner()

  onCleanup(() => disposeFallback?.())

  const fail = (error: unknown) => {
    reportError(error, islandOf(region.parent))

    if (failed)
      return

    failed = true
    disposeBlock?.()
    // What the block built, or claimed before it threw, goes; the fallback is built afresh.
    region.clear()
    current = []

    if (fallback) {
      runWithOwner(parent, () => root((dispose) => {
        disposeFallback = dispose
        current = unrecorded(() => fresh(() => show(region, [], () => fallback(error))))
      }))
    }
  }

  catchError((dispose) => {
    disposeBlock = dispose

    try {
      current = show(region, current, render)
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
  return (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(ISLAND_SLOT)?.dataset.component
}

function failedOnServer(region: Region): boolean {
  const first = region.start ? region.start.nextSibling : region.element!.firstChild

  return first?.nodeType === 8 && (first as Comment).data === FAILED_MARKER_DATA
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

  const element = claim ? claimNode() as Element : createElement(tag)

  spread(element, () => [props], 'children' in props)

  return element
}

function createElement(tag: string): Element {
  const element = document.createElement(tag)

  return element instanceof HTMLUnknownElement && !tag.includes('-') ? document.createElementNS('http://www.w3.org/2000/svg', tag) : element
}

// Props from several objects, later ones winning, each keeping its getters, so a prop stays live and children build only when read.
export function merge(...sources: readonly object[]): Record<string, unknown> {
  const props = {}

  for (const source of sources) {
    if (source != null)
      Object.defineProperties(props, Object.getOwnPropertyDescriptors(source))
  }

  return props
}

export function omit(props: object, ...keys: string[]): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(props)

  for (const key of keys)
    delete descriptors[key]

  return Object.defineProperties({}, descriptors)
}

// ---- attributes and events

export function attribute(element: Element, name: string, value: unknown): void {
  if (value == null || value === false)
    element.removeAttribute(name)
  else
    element.setAttribute(name, value === true ? '' : safeUrl(name, String(value)))
}

// An `img` source, with the variants and size of an imported image; a later source clears what an earlier one set.
export function image(element: Element, src: unknown, sized: boolean): void {
  const props = imageSource(src, sized) as Record<string, unknown>

  for (const name of sized ? ['src', 'srcset'] : ['src', 'srcset', 'width', 'height'])
    attribute(element, name, props[name])
}

// A property where the element has one, such as an input's `value`; an attribute otherwise.
export function property(element: Element, name: string, value: unknown): void {
  // The server wrote this value, and what the person typed or ticked since stays for the replayed event to read.
  if (claim && (name === 'value' || name === 'checked'))
    return

  if (VOID_PROPERTIES.has(name) && name in element)
    (element as ElementRecord)[name] = name === 'value' ? (value ?? '') : value
  else if (CONTENT_PROPERTIES.has(name))
    (element as ElementRecord)[name] = value ?? ''
  else
    attribute(element, name, value)
}

export function className(value: unknown): string {
  if (typeof value === 'number')
    return String(value)

  if (!value)
    return ''

  if (typeof value === 'string')
    return value

  const classes = Array.isArray(value) ? flattenClasses(value, {}) : value as Record<string, unknown>
  let result = ''

  for (const key of Object.keys(classes)) {
    if (key && key !== 'undefined' && classes[key])
      result += result ? ` ${key}` : key
  }

  return result
}

// A class bound to an expression is never in the template, so a fresh element starts with none; a claimed one has the server's, set again.
export function setClass(element: Element, value: unknown): void {
  const name = className(value)
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
  if (!value) {
    element.removeAttribute('style')

    return
  }

  if (typeof value === 'string') {
    element.setAttribute('style', value)

    return
  }

  let text = ''

  for (const [name, property] of Object.entries(value as Record<string, unknown>)) {
    if (property != null)
      text += `${text ? ';' : ''}${name}:${String(property)}`
  }

  element.setAttribute('style', text)
}

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

function unlisten(element: Element, name: string, handler: (event: Event) => void): void {
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

  Object.defineProperty(event, 'currentTarget', { configurable: true, get: () => node ?? document })

  while (node) {
    const handler = (node as unknown as Record<string, unknown>)[key] as ((event: Event) => void) | undefined

    if (handler && !(node as unknown as { disabled?: boolean }).disabled) {
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
      if (name === 'children')
        continue

      const value = props[name]

      seen.add(name)

      if (set.get(name) === value)
        continue

      const previous = set.get(name)

      set.set(name, value)

      if (name === 'ref')
        ref(element, value)
      else if (name.startsWith('on') && name !== 'open' && typeof value === 'function')
        listen(element, name, value as (event: Event) => void, previous as ((event: Event) => void) | undefined)
      else if (name === 'class')
        setClass(element, value)
      else if (name === 'style')
        setStyle(element, value)
      else
        property(element, name, value)
    }

    for (const [name, previous] of set) {
      if (seen.has(name))
        continue

      set.delete(name)

      if (name.startsWith('on') && name !== 'open' && typeof previous === 'function')
        unlisten(element, name, previous as (event: Event) => void)
      else if (name !== 'ref')
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
