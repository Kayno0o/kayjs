// High-performance keyed list reconciler: fast prefix/suffix, DocumentFragment batch insert,
// LIS minimal DOM moves (swap = 2 moves), and O(1) parent.textContent = '' clear.

import type { Owner, Signal } from '../reactivity/index'
import { createOwner, disposeOwner, effect, getOwner, onCleanup, runWithOwner, signal, untrack } from '../reactivity/index'
import { claimLoop, hydrateCursor, skipRange } from './index'

interface Row<T> {
  key: unknown
  node: Node | null
  nodes?: Node[] | undefined
  item: Signal<T>
  index: Signal<number> | undefined
  owner: Owner
}

const EMPTY: readonly never[] = []
const EMPTY_NUMS: number[] = []

function nextAnchor<T>(rows: Row<T>[], from: number, fallback: Node | null): Node | null {
  for (let i = from; i < rows.length; i++) {
    const n = rows[i]!.node
    if (n !== null)
      return n
  }
  return fallback
}

function insertRow<T>(parent: Node, row: Row<T>, anchor: Node | null): void {
  const list = row.nodes
  if (list === undefined) {
    if (row.node !== null)
      parent.insertBefore(row.node, anchor)
    return
  }
  const first = list[0]!
  const last = list[list.length - 1]!
  const fp = first.parentNode
  if (fp !== null && fp === last.parentNode && fp.nodeType !== 11) {
    for (let cur: Node | null = first; cur !== null;) {
      const next: Node | null = cur === last ? null : cur.nextSibling
      parent.insertBefore(cur, anchor)
      cur = next
    }
    return
  }
  for (let i = 0; i < list.length; i++)
    parent.insertBefore(list[i]!, anchor)
}

function removeRow<T>(parent: Node, row: Row<T>): void {
  const list = row.nodes
  if (list === undefined) {
    if (row.node !== null)
      parent.removeChild(row.node)
    return
  }
  const first = list[0]!
  const last = list[list.length - 1]!
  const fp = first.parentNode
  if (fp !== null && fp === last.parentNode) {
    for (let cur: Node | null = first; cur !== null;) {
      const next: Node | null = cur === last ? null : cur.nextSibling
      fp.removeChild(cur)
      cur = next
    }
    return
  }
  for (let i = 0; i < list.length; i++)
    list[i]!.parentNode?.removeChild(list[i]!)
}

// A new rows array holding the kept prefix and suffix of the old one, with room for the middle.
function keepEnds<T>(rows: Row<T>[], start: number, oldEnd: number, newEnd: number, nextLen: number): Row<T>[] {
  const result = new Array<Row<T>>(nextLen)
  for (let i = 0; i < start; i++)
    result[i] = rows[i]!
  for (let i = newEnd; i < nextLen; i++)
    result[i] = rows[oldEnd + (i - newEnd)]!
  return result
}

type RenderRow<T> = (item: Signal<T>, index?: Signal<number>) => Node | DocumentFragment | null | undefined | boolean | string | number


// While hydrating, a row that rendered no node of its own takes the server nodes the cursor moved over since `before`.
function adoptRowNodes<T>(parent: Node, marker: Node | null, row: Row<T>, before: Node | null): void {
  const afterCursor = hydrateCursor()
  if (row.node === null && before !== null && before !== afterCursor) {
    const claimed: Node[] = []
    for (let n: Node | null = before; n !== null && n !== afterCursor; n = n.nextSibling) {
      if (n.nodeType === 8 && (n as Comment).data === 'k]')
        break
      claimed.push(n)
    }
    if (claimed.length === 1) {
      row.node = claimed[0]!
    }
    else if (claimed.length > 1) {
      row.node = claimed[0]!
      row.nodes = claimed
    }
  }
  else if (row.node !== null && row.node.parentNode !== parent) {
    insertRow(parent, row, marker)
  }
}

export function loop<T>(
  parent: Node,
  marker: Node | null,
  each: () => readonly T[] | null | undefined | false,
  keyFn: (item: T, index: number) => unknown,
  renderRow: RenderRow<T>,
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

  // A row that throws is disposed and left empty under a key no item matches, so the next update renders it again; its error is rethrown once the loop's rows match the DOM.
  let failed = false
  let error: unknown
  const makeRow = (itemVal: T, idx: number, key: unknown): Row<T> => {
    const owner = createOwner(parentOwner)
    const item = signal(itemVal)
    const index = needsIndex ? signal(idx) : undefined
    let raw: ReturnType<RenderRow<T>>
    try {
      raw = runWithOwner(owner, () => renderRow(item, index))
    }
    catch (err) {
      disposeOwner(owner)
      if (!failed) {
        failed = true
        error = err
      }
      return { key: Symbol(), node: null, item, index, owner }
    }
    let node: Node | null = null
    let nodes: Node[] | undefined
    if (raw instanceof Node) {
      if (raw.nodeType === 11) {
        const len = raw.childNodes.length
        if (len === 1) {
          node = raw.firstChild
        }
        else if (len > 1) {
          nodes = Array.from(raw.childNodes)
          node = nodes[0]!
        }
      }
      else {
        node = raw
      }
    }
    else if (typeof raw === 'string' || typeof raw === 'number') {
      const str = String(raw)
      if (str !== '')
        node = document.createTextNode(str)
    }
    return nodes !== undefined ? { key, node, nodes, item, index, owner } : { key, node, item, index, owner }
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
            removeRow(parent, rows[i]!)
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
            const before = hydrateCursor()
            const row = makeRow(item, i, keyFn(item, i))
            adoptRowNodes(parent, marker, row, before)
            created[i] = row
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
          insertRow(frag, row, null)
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

      const after = nextAnchor(rows, oldEnd, marker)

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
          insertRow(frag, row, null)
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
          removeRow(parent, row)
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
          insertRow(frag, row, null)
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
          removeRow(parent, row)
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
            insertRow(parent, row, anchor)
        }
        else {
          row = makeRow(next[idx]!, idx, newKeys[i])
          insertRow(parent, row, anchor)
        }
        result[idx] = row
        if (row.node !== null)
          anchor = row.node
      }

      rows = result
    })
    if (failed) {
      failed = false
      throw error
    }
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
