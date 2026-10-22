import type { Unit } from './dom'
import { animated, blockIn, claiming, entered, firstOf, insertUnit, lastOf, Region, release, removeUnit, rowUnit, swap, units, within } from './dom'
import { createSignal, onCleanup, renderEffect, root, unrecorded, untrack } from './reactive'

declare const KAY_FRENCH: true | undefined

// The `for` block: its own module, as keyed reconciling weighs on a page whose islands loop over nothing.

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
      const made = units(typeof KAY_FRENCH === 'undefined' ? value : within(region.parent, value))

      return { key: rowKey, unit: rowUnit(made), setItem: setItem as (item: unknown) => void, setIndex, dispose }
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
      rows = claiming() && !entering ? region.claim(() => list.map((item, index) => makeRow(item, index, key === false ? index : key(item)))) : reconcileRows(region, rows, list, key, makeRow)

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

  const matched: (Row | undefined)[] = []
  let fresh = false

  for (let index = start; index < newEnd; index++) {
    const row = byKey.get(keys[index])

    if (row)
      byKey.delete(keys[index])
    else if (typeof keys[index] === 'object' && keys[index] !== null)
      fresh = true

    matched.push(row)
  }

  // A list of plain objects edited immutably comes back as copies no key matches: a copy takes the row left unmatched in its place between the rows around it, so an edit, a removal or an insertion keeps the other rows' nodes, fields and focus.
  const replaced = fresh && key === rowKey && byKey.size > 0 ? pairCopies(previous, matched, keys, byKey, start, oldEnd) : undefined
  const middle: Row[] = []
  let added = 0

  for (let index = start; index < newEnd; index++) {
    const row = matched[index - start] ?? replaced?.get(index)

    if (row) {
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

// Gives each unmatched object key a row left in `byKey` that sits, in the old order, between the old rows matched around it, and takes those rows out of `byKey`, the pair's key being the new one. Best effort: a removal and an edit in the same gap pair the first leftover row with the copy.
function pairCopies(previous: Row[], matched: (Row | undefined)[], keys: unknown[], byKey: Map<unknown, Row>, start: number, oldEnd: number): Map<number, Row> {
  const oldAt = new Map<Row, number>()

  for (let index = start; index < oldEnd; index++)
    oldAt.set(previous[index]!, index)

  const left = [...byKey.values()].sort((a, b) => oldAt.get(a)! - oldAt.get(b)!)
  const paired = new Map<number, Row>()
  // The old index of the next matched row after each position.
  const next: number[] = []
  let following = oldEnd
  let before = start - 1
  let cursor = 0

  for (let at = matched.length - 1; at >= 0; at--) {
    if (matched[at])
      following = Math.min(following, oldAt.get(matched[at]!)!)

    next[at] = following
  }

  for (let at = 0; at < matched.length; at++) {
    const row = matched[at]

    if (row) {
      before = Math.max(before, oldAt.get(row)!)

      continue
    }

    const key = keys[start + at]

    if (typeof key !== 'object' || key === null)
      continue

    while (cursor < left.length && oldAt.get(left[cursor]!)! <= before)
      cursor++

    const candidate = left[cursor]

    if (candidate && oldAt.get(candidate)! < next[at]! && typeof candidate.key === 'object' && candidate.key !== null) {
      paired.set(start + at, candidate)
      byKey.delete(candidate.key)
      candidate.key = key
      cursor++
    }
  }

  return paired
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
