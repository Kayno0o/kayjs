// Claiming the SSR nodes of a list or an insert while hydrating (`dom-claim`): only the islands that render one load it.

import { hydrateCursor, isHydrating, isRangeEnd, moveCursor, skipRange } from './index'

export function claimLoop(parent: Node, fn: () => void, skip = 0, startMarker?: Node | null): boolean {
  if (!isHydrating())
    return false
  let cur: Node | null
  if (startMarker !== undefined && startMarker !== null) {
    cur = startMarker.nextSibling
  }
  else {
    cur = parent.firstChild
    for (let i = 0; i < skip && cur !== null; i++) {
      cur = cur.nextSibling
      while (cur !== null && (cur as unknown as { __kayAnchor?: boolean }).__kayAnchor === true)
        cur = cur.nextSibling
    }
  }
  const prev = cur === null || isRangeEnd(cur) ? moveCursor(false, null) : moveCursor(true, cur)
  try {
    fn()
  }
  finally {
    moveCursor(...prev)
  }
  return true
}

// The siblings from `from` up to, not including, `to`; undefined when there are none.
function between(from: Node | null, to: Node | null): Node[] | undefined {
  const nodes: Node[] = []
  for (let n = from; n !== null && n !== to; n = n.nextSibling)
    nodes.push(n)
  return nodes.length > 0 ? nodes : undefined
}

// `nodes` is the SSR range the render claimed through template() (a fragment hydrates to null, so the caller learns its nodes here).
export function claimInsert<T>(
  parent: Node,
  marker: Node | null,
  fn: () => T,
  startMarker?: Node | null,
): { result: T, marker: Node | null, claimed: Node | null, nodes: Node[] | undefined, consumed: boolean } {
  if (!isHydrating())
    return { result: fn(), marker, claimed: null, nodes: undefined, consumed: false }

  let claimed: Node | null
  if (startMarker !== undefined) {
    const first = startMarker === null ? parent.firstChild : startMarker.nextSibling
    claimed = first === marker || (first !== null && isRangeEnd(first)) ? null : first
  }
  else {
    claimed = marker === null ? parent.lastChild : marker.nodeType === 8 ? null : marker
  }
  const prev = claimed === null ? moveCursor(false, null) : moveCursor(true, claimed)
  let result: T
  let end: Node | null
  try {
    result = fn()
    end = hydrateCursor()
  }
  finally {
    moveCursor(...prev)
  }
  const consumed = claimed !== null && end !== claimed
  if (startMarker !== undefined) {
    const firstNow = startMarker === null ? parent.firstChild : startMarker.nextSibling
    return { result, marker, claimed, nodes: between(firstNow, marker), consumed }
  }
  if (marker === null) {
    const from = claimed !== null && claimed.parentNode === parent ? claimed : parent.lastChild
    return { result, marker: null, claimed, nodes: claimed !== null ? between(from, end) : undefined, consumed }
  }
  if (claimed === null)
    return { result, marker, claimed, nodes: undefined, consumed: false }

  // The anchor goes after the claimed range; a text value or a nested insert moves no cursor and claims the one node.
  const anchor = document.createComment('')
  ;(anchor as unknown as { __kayAnchor?: boolean }).__kayAnchor = true
  const from = claimed.parentNode === parent ? claimed : null
  parent.insertBefore(anchor, consumed ? end : from?.nextSibling ?? null)
  return { result, marker: anchor, claimed, nodes: consumed && from !== null ? between(from, anchor) : undefined, consumed }
}

export function eachStatic<T>(
  parent: Node,
  marker: Node | null,
  items: readonly T[] | null | undefined,
  render: (item: T, index: number) => Node,
  skip = 0,
): void {
  if (!items || items.length === 0)
    return
  let startMarker: Node | null | undefined
  let insertBefore = marker
  if (marker !== null && marker.nodeType === 8 && (marker as Comment).data === 'k[') {
    const close = skipRange(marker)
    if (close !== null) {
      startMarker = marker
      insertBefore = close
    }
  }
  if (claimLoop(parent, () => {
    for (let i = 0; i < items.length; i++) {
      const node = render(items[i]!, i)
      if (node != null && node.parentNode !== parent)
        parent.insertBefore(node, insertBefore)
    }
  }, skip, startMarker)) {
    return
  }
  const f = document.createDocumentFragment()
  for (let i = 0; i < items.length; i++) {
    const node = render(items[i]!, i)
    if (node != null)
      f.appendChild(node)
  }
  parent.insertBefore(f, insertBefore)
}
