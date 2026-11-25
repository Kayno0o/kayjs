// High-performance keyed list reconciler: fast prefix/suffix, DocumentFragment batch insert,
// LIS minimal DOM moves (swap = 2 moves), and O(1) parent.textContent = '' clear.

import type { Owner, Signal } from '../reactivity/index'
import { createOwner, disposeOwner, effect, getOwner, onCleanup, runWithOwner, signal, untrack } from '../reactivity/index'
import { claimLoop, skipRange } from './index'

interface Row<T> {
  key: unknown
  node: Node
  item: Signal<T>
  index: Signal<number> | undefined
  owner: Owner
}

const EMPTY: readonly never[] = []
const EMPTY_NUMS: number[] = []

// A new rows array holding the kept prefix and suffix of the old one, with room for the middle.
function keepEnds<T>(rows: Row<T>[], start: number, oldEnd: number, newEnd: number, nextLen: number): Row<T>[] {
  const result = new Array<Row<T>>(nextLen)
  for (let i = 0; i < start; i++)
    result[i] = rows[i]!
  for (let i = newEnd; i < nextLen; i++)
    result[i] = rows[oldEnd + (i - newEnd)]!
  return result
}

export function loop<T>(
  parent: Node,
  marker: Node | null,
  each: () => readonly T[] | null | undefined | false,
  keyFn: (item: T, index: number) => unknown,
  renderRow: (item: Signal<T>, index?: Signal<number>) => Node,
  skip = 0,
): void {
  const parentOwner = getOwner()
  const needsIndex = renderRow.length >= 2
  let rows: Row<T>[] = []
  let firstRun = true
  if (parentOwner !== undefined) {
    onCleanup(() => {
      rows = []
    })
  }

  const makeRow = (itemVal: T, idx: number, key: unknown): Row<T> => {
    const owner = createOwner(parentOwner)
    const item = signal(itemVal)
    const index = needsIndex ? signal(idx) : undefined
    const node = runWithOwner(owner, () => renderRow(item, index))
    return { key, node, item, index, owner }
  }

  effect(() => {
    let startMarker: Node | null | undefined
    if (firstRun) {
      firstRun = false
      if (marker !== null && marker.nodeType === 8 && (marker as Comment).data === 'k[') {
        const close = skipRange(marker)
        if (close !== null) {
          startMarker = marker
          marker = close
        }
      }
    }

    const list = each()
    const next = list === false || list == null ? EMPTY : list
    const nextLen = next.length
    const prevLen = rows.length

    untrack(() => {
      // Fast path 1: Clear all rows
      if (nextLen === 0) {
        if (prevLen === 0)
          return
        for (let i = 0; i < prevLen; i++)
          disposeOwner(rows[i]!.owner)
        if (marker === null && skip === 0) {
          ;(parent as Element).textContent = ''
        }
        else {
          for (let i = 0; i < prevLen; i++)
            parent.removeChild(rows[i]!.node)
        }
        rows = []
        return
      }

      // Fast path 2: Initial creation from empty
      if (prevLen === 0) {
        const created = new Array<Row<T>>(nextLen)
        if (claimLoop(parent, () => {
          for (let i = 0; i < nextLen; i++) {
            const item = next[i]!
            created[i] = makeRow(item, i, keyFn(item, i))
          }
        }, skip, startMarker)) {
          rows = created
          return
        }

        const frag = document.createDocumentFragment()
        for (let i = 0; i < nextLen; i++) {
          const item = next[i]!
          const row = makeRow(item, i, keyFn(item, i))
          created[i] = row
          frag.appendChild(row.node)
        }
        parent.insertBefore(frag, marker)
        rows = created
        return
      }

      // Common prefix scan
      let start = 0
      while (start < prevLen && start < nextLen) {
        const item = next[start]!
        const k = keyFn(item, start)
        const prevRow = rows[start]!
        if (prevRow.key !== k)
          break
        prevRow.item.value = item
        if (prevRow.index !== undefined)
          prevRow.index.value = start
        start++
      }

      // Common suffix scan
      let oldEnd = prevLen
      let newEnd = nextLen
      while (oldEnd > start && newEnd > start) {
        const item = next[newEnd - 1]!
        const k = keyFn(item, newEnd - 1)
        const prevRow = rows[oldEnd - 1]!
        if (prevRow.key !== k)
          break
        prevRow.item.value = item
        if (prevRow.index !== undefined)
          prevRow.index.value = newEnd - 1
        oldEnd--
        newEnd--
      }

      // Fast path 3: In-place update only (e.g. update every 10th row)
      if (start === oldEnd && start === newEnd)
        return

      const after = oldEnd < prevLen ? rows[oldEnd]!.node : marker

      // Fast path 4: Pure insertion (e.g. append 1,000 rows)
      if (start === oldEnd) {
        const addCount = newEnd - start
        const result = keepEnds(rows, start, oldEnd, newEnd, nextLen)
        const frag = document.createDocumentFragment()
        for (let i = 0; i < addCount; i++) {
          const idx = start + i
          const item = next[idx]!
          const row = makeRow(item, idx, keyFn(item, idx))
          result[idx] = row
          frag.appendChild(row.node)
        }
        parent.insertBefore(frag, after)
        rows = result
        return
      }

      // Fast path 5: Pure removal (e.g. remove 1 row)
      if (start === newEnd) {
        for (let i = start; i < oldEnd; i++) {
          const row = rows[i]!
          disposeOwner(row.owner)
          parent.removeChild(row.node)
        }
        rows = keepEnds(rows, start, oldEnd, newEnd, nextLen)
        return
      }

      // General middle reconcile
      const oldMap = new Map<unknown, number>()
      for (let i = start; i < oldEnd; i++)
        oldMap.set(rows[i]!.key, i)

      const midLen = newEnd - start
      const result = keepEnds(rows, start, oldEnd, newEnd, nextLen)

      const used = new Uint8Array(oldEnd - start)
      let reused = 0

      const newKeys = new Array<unknown>(midLen)
      const matchedOldIdx = new Int32Array(midLen)
      for (let i = 0; i < midLen; i++) {
        const idx = start + i
        const k = keyFn(next[idx]!, idx)
        newKeys[i] = k
        const oldIdx = oldMap.get(k)
        if (oldIdx !== undefined && used[oldIdx - start] === 0) {
          used[oldIdx - start] = 1
          matchedOldIdx[i] = oldIdx
          reused++
        }
        else {
          matchedOldIdx[i] = -1
        }
      }

      // Full replacement fast path (replace 1,000 rows)
      if (reused === 0 && start === 0 && oldEnd === prevLen && marker === null && skip === 0) {
        for (let i = 0; i < prevLen; i++)
          disposeOwner(rows[i]!.owner)
        ;(parent as Element).textContent = ''
        const frag = document.createDocumentFragment()
        for (let i = 0; i < nextLen; i++) {
          const row = makeRow(next[i]!, i, newKeys[i])
          result[i] = row
          frag.appendChild(row.node)
        }
        parent.appendChild(frag)
        rows = result
        return
      }

      // Remove unused old rows
      for (let i = start; i < oldEnd; i++) {
        if (used[i - start] === 0) {
          const row = rows[i]!
          disposeOwner(row.owner)
          parent.removeChild(row.node)
        }
      }

      // Longest Increasing Subsequence for minimal DOM moves (swap = 2 moves)
      const lis = reused > 0 ? longestIncreasingSubsequence(matchedOldIdx) : EMPTY_NUMS
      let lisPos = lis.length - 1

      let anchor: Node | null = after
      for (let i = midLen - 1; i >= 0; i--) {
        const idx = start + i
        const oldIdx = matchedOldIdx[i]!
        let row: Row<T>
        if (oldIdx !== -1) {
          row = rows[oldIdx]!
          row.item.value = next[idx]!
          if (row.index !== undefined)
            row.index.value = idx
          if (lisPos >= 0 && lis[lisPos] === i)
            lisPos--
          else
            parent.insertBefore(row.node, anchor)
        }
        else {
          row = makeRow(next[idx]!, idx, newKeys[i])
          parent.insertBefore(row.node, anchor)
        }
        result[idx] = row
        anchor = row.node
      }

      rows = result
    })
  })
}

function longestIncreasingSubsequence(arr: Int32Array): number[] {
  const n = arr.length
  const p = new Int32Array(n)
  const result: number[] = []

  for (let i = 0; i < n; i++) {
    const val = arr[i]!
    if (val === -1)
      continue

    const lastIdx = result.length - 1
    if (lastIdx < 0 || arr[result[lastIdx]!]! < val) {
      p[i] = lastIdx >= 0 ? result[lastIdx]! : -1
      result.push(i)
      continue
    }

    let lo = 0
    let hi = lastIdx
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (arr[result[mid]!]! < val)
        lo = mid + 1
      else
        hi = mid
    }

    if (val < arr[result[lo]!]!) {
      if (lo > 0)
        p[i] = result[lo - 1]!
      result[lo] = i
    }
  }

  let len = result.length
  let cur = len > 0 ? result[len - 1]! : -1
  while (len-- > 0) {
    result[len] = cur
    cur = p[cur]!
  }

  return result
}
