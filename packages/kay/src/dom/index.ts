// Kay v2 minimal DOM & hydration core (loop -> @kayjs/kay/internal/dom-loop, extras -> @kayjs/kay/internal/dom-extras for fine-grained chunk splitting).

import { isBlockedAttr, isStringBoolAttr, isUnsafeUrlAttr } from '../attrs'
import { batch, createOwner, disposeOwner, getOwner, onCleanup, runWithOwner } from '../reactivity/index'
import { styleText } from '../style'
import { assertRenderable } from '../unrenderable'

export { isBlockedAttr } from '../attrs'
export { effect } from '../reactivity/index'

let hydrating = false
let hydrateNode: Node | null = null
let hydrateRoot: Element | null = null

function isRangeEnd(node: Node): boolean {
  return node.nodeType === 8 && (node as Comment).data === 'k]'
}

export function hydrateCursor(): Node | null {
  return hydrating ? hydrateNode : null
}

export function claimLoop(parent: Node, fn: () => void, skip = 0, startMarker?: Node | null): boolean {
  if (!hydrating)
    return false
  const prevHydrating = hydrating
  const prevCursor = hydrateNode
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
  if (cur === null || isRangeEnd(cur)) {
    hydrating = false
    hydrateNode = null
  }
  else {
    hydrateNode = cur
  }
  try {
    fn()
  }
  finally {
    hydrating = prevHydrating
    hydrateNode = prevCursor
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
  if (!hydrating)
    return { result: fn(), marker, claimed: null, nodes: undefined, consumed: false }

  let claimed: Node | null
  if (startMarker !== undefined) {
    const first = startMarker === null ? parent.firstChild : startMarker.nextSibling
    claimed = first === marker || (first !== null && isRangeEnd(first)) ? null : first
  }
  else {
    claimed = marker === null ? parent.lastChild : marker.nodeType === 8 ? null : marker
  }
  const prevHydrating = hydrating
  const prevNode = hydrateNode
  if (claimed === null) {
    hydrating = false
    hydrateNode = null
  }
  else {
    hydrateNode = claimed
  }
  let result: T
  let end: Node | null
  try {
    result = fn()
    end = hydrateNode
  }
  finally {
    hydrating = prevHydrating
    hydrateNode = prevNode
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

export function hydrate(container: Element, render: () => Node | DocumentFragment | null, idPrefix?: string): () => void {
  const owner = createOwner(undefined)
  if (idPrefix !== undefined)
    owner.id = { p: idPrefix, n: 0 }
  const prevHydrating = hydrating
  const prevNode = hydrateNode
  const prevRoot = process.env.NODE_ENV !== 'production' ? hydrateRoot : null
  hydrating = true
  hydrateNode = container.firstChild
  if (process.env.NODE_ENV !== 'production')
    hydrateRoot = container

  try {
    runWithOwner(owner, () => {
      render()
    })
  }
  catch (err) {
    disposeOwner(owner)
    throw err
  }
  finally {
    hydrating = prevHydrating
    hydrateNode = prevNode
    if (process.env.NODE_ENV !== 'production')
      hydrateRoot = prevRoot
  }

  return () => disposeOwner(owner)
}

export function mount(container: Element, render: () => Node | DocumentFragment | null, idPrefix?: string): () => void {
  const owner = createOwner(undefined)
  if (idPrefix !== undefined)
    owner.id = { p: idPrefix, n: 0 }
  const prevHydrating = hydrating
  hydrating = false
  try {
    const node = runWithOwner(owner, render)
    container.textContent = ''
    if (node !== null)
      container.appendChild(node)
  }
  catch (err) {
    disposeOwner(owner)
    throw err
  }
  finally {
    hydrating = prevHydrating
  }
  return () => disposeOwner(owner)
}

function warnMismatch(node: Node, expectedTag: string, steppedOver: boolean): void {
  const island = hydrateRoot?.getAttribute('c') ?? hydrateRoot?.tagName.toLowerCase() ?? 'unknown'
  const found = node.nodeType === 1
    ? `<${(node as Element).tagName.toLowerCase()}>`
    : node.nodeType === 3
      ? `#text(${JSON.stringify((node as Text).data.slice(0, 30))})`
      : node.nodeType === 8
        ? `<!--${(node as Comment).data}-->`
        : `nodeType(${node.nodeType})`
  console.warn(`kay: hydration mismatch in island "${island}": expected <${expectedTag}>, found ${found}; ${steppedOver ? `hydrating the next <${expectedTag}>` : 'falling back to fresh clone'}.`)
}

export function template(html: string, isSvg?: boolean): () => Node {
  let cached: Node | undefined
  const expectedTag = /^<([A-Za-z][^\s/>]*)/.exec(html)?.[1]?.toLowerCase()

  const clone = (): Node => {
    if (cached === undefined) {
      const t = document.createElement('template')
      t.innerHTML = isSvg ? `<svg>${html}</svg>` : html
      cached = isSvg ? t.content.firstChild!.firstChild! : t.content.firstChild!
    }
    return cached.cloneNode(true)
  }

  return (): Node => {
    if (hydrating && hydrateNode !== null) {
      const stale = hydrateNode
      // Stop at a closing range marker so a mismatch inside a branch never steals or replaces nodes outside it.
      if (isRangeEnd(stale)) {
        if (process.env.NODE_ENV !== 'production' && expectedTag !== undefined)
          warnMismatch(stale, expectedTag, false)
        hydrating = false
        hydrateNode = null
        return clone()
      }
      // A node injected before the markup (an extension, a password manager) is stepped over; no matching node at all means the server rendered something else.
      let node: Node | null = stale
      while (node !== null && !isRangeEnd(node) && expectedTag !== undefined && node.nodeName.toLowerCase() !== expectedTag)
        node = node.nextSibling
      if (node !== null && isRangeEnd(node))
        node = null
      if (process.env.NODE_ENV !== 'production' && node !== stale)
        warnMismatch(stale, expectedTag!, node !== null)
      if (node === null) {
        hydrating = false
        hydrateNode = null
        const fresh = clone()
        stale.parentNode?.replaceChild(fresh, stale)
        return fresh
      }
      hydrateNode = node.nextSibling
      return node
    }

    return clone()
  }
}

// Moves the hydration cursor past the SSR range of a root fragment's dynamic child (`<!--k[-->...<!--k]-->` or `<!---->text<!---->`) and returns its opening marker; null when not hydrating.
export function claimRange(): Node | null {
  const start = hydrating ? hydrateNode : null
  if (start === null || start.nodeType !== 8)
    return null
  hydrateNode = skipRange(start)?.nextSibling ?? null
  return start
}

// A text child of a root fragment, claimed from the SSR markup while hydrating; a dynamic one sits between `<!---->` markers.
export function fragText(data: string, dynamic?: boolean): Text {
  if (dynamic) {
    const start = claimRange()
    if (start !== null)
      return textAfter(start)
  }
  else if (hydrating && hydrateNode !== null && hydrateNode.nodeType === 3) {
    const text = hydrateNode as Text
    hydrateNode = text.nextSibling
    return text
  }
  return document.createTextNode(data)
}

export function frag(...nodes: Node[]): Node | null {
  if (hydrating)
    return null
  const f = document.createDocumentFragment()
  for (let i = 0; i < nodes.length; i++)
    f.appendChild(nodes[i]!)
  return f
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

export function firstText(el: Node): Text {
  const first = el.firstChild
  if (first !== null && first.nodeType === 3)
    return first as Text
  const text = document.createTextNode('')
  el.insertBefore(text, first)
  return text
}

export function textAfter(marker: Node): Text {
  const next = marker.nextSibling
  if (next !== null && next.nodeType === 3)
    return next as Text
  const text = document.createTextNode('')
  marker.parentNode!.insertBefore(text, next)
  return text
}

/** Advance past an optional SSR text node (`<!-->text<!-->` or `<!--><!-->`) to the closing comment marker. */
export function skipText(marker: Node): Node | null {
  const next = marker.nextSibling
  return next !== null && next.nodeType === 3 ? next.nextSibling : next
}

/** Advance past an SSR-bracketed dynamic range (`<!--k[-->...<!--k]-->` or `<!---->...<!---->`) to its closing comment marker. */
export function skipRange(marker: Node): Node | null {
  const balanced = marker.nodeType === 8 && (marker as Comment).data === 'k['
  let depth = balanced ? 1 : 0
  let cur = marker.nextSibling
  while (cur !== null) {
    if (cur.nodeType === 8) {
      if (!balanced)
        return cur
      const data = (cur as Comment).data
      if (data === 'k[')
        depth++
      else if (data === 'k]' && --depth === 0)
        return cur
    }
    cur = cur.nextSibling
  }
  return null
}

export function setText(node: Text, value: unknown): void {
  if (process.env.NODE_ENV !== 'production')
    assertRenderable(value, 'text')
  const str = value == null || typeof value === 'boolean' ? '' : String(value)
  if (node.data !== str)
    node.data = str
}

export function setClass(el: Element, value: unknown): void {
  if (process.env.NODE_ENV !== 'production')
    assertRenderable(value, 'class')
  const str = value == null || value === false ? '' : String(value)
  if (typeof el.className === 'string') {
    if (el.className !== str) {
      if (str === '')
        el.removeAttribute('class')
      else
        el.className = str
    }
  }
  else if (str === '') {
    el.removeAttribute('class')
  }
  else {
    el.setAttribute('class', str)
  }
}

export function setAttr(el: Element, name: string, value: unknown): void {
  if (isBlockedAttr(name))
    return
  if (process.env.NODE_ENV !== 'production')
    assertRenderable(value, name)
  if (value == null) {
    el.removeAttribute(name)
  }
  else if (typeof value === 'boolean') {
    if (isStringBoolAttr(name))
      el.setAttribute(name, value ? 'true' : 'false')
    else if (value)
      el.setAttribute(name, '')
    else
      el.removeAttribute(name)
  }
  else if (isUnsafeUrlAttr(name, value, el.tagName)) {
    if (process.env.NODE_ENV !== 'production')
      console.warn(`kay: dropped unsafe URL on <${el.tagName.toLowerCase()} ${name}>.`)
    el.removeAttribute(name)
  }
  else {
    el.setAttribute(name, String(value))
  }
}

export function setProp(el: Element, name: string, value: unknown): void {
  const next = name === 'value'
    ? (value == null ? '' : String(value))
    : Boolean(value)
  const rec = el as unknown as Record<string, unknown>
  if (rec[name] !== next)
    rec[name] = next
}

export function setStyle(el: HTMLElement, value: unknown): void {
  if (value == null || value === false) {
    el.removeAttribute('style')
  }
  else if (typeof value === 'string') {
    el.style.cssText = value
  }
  else if (typeof value === 'object') {
    el.style.cssText = styleText(value as Record<string, unknown>)
  }
}

// ---- Delegated events

const delegated = new WeakMap<Document, Set<string>>()

function dispatchEvent(event: Event): void {
  const key = `$$${event.type}`
  let current: EventTarget | null = null
  const prevDesc = Object.getOwnPropertyDescriptor(event, 'currentTarget')
  Object.defineProperty(event, 'currentTarget', { configurable: true, get: () => current })

  try {
    const path = event.composedPath?.()
    const usePath = path !== undefined && path.length > 0
    let i = 0
    let node = (usePath ? path[0] : event.target) as (EventTarget & Record<string, ((e: Event) => void) | undefined>) | null | undefined
    while (node != null) {
      const handler = node[key]
      if (typeof handler === 'function') {
        current = node
        batch(() => handler(event))
        if (event.cancelBubble)
          return
      }
      node = (usePath ? path[++i] : (node as unknown as Node).parentNode) as (EventTarget & Record<string, ((e: Event) => void) | undefined>) | null | undefined
    }
  }
  finally {
    if (prevDesc !== undefined)
      Object.defineProperty(event, 'currentTarget', prevDesc)
    else
      delete (event as unknown as Record<string, unknown>).currentTarget
  }
}

export function delegate(events: string[]): void {
  if (typeof document === 'undefined')
    return
  let set = delegated.get(document)
  if (set === undefined) {
    set = new Set()
    delegated.set(document, set)
  }
  for (let i = 0; i < events.length; i++) {
    const type = events[i]!
    if (!set.has(type)) {
      set.add(type)
      document.addEventListener(type, dispatchEvent)
    }
  }
}

export function on(el: Node, event: string, handler: ((e: Event) => void) | false | null | undefined): void {
  if (typeof handler !== 'function')
    return
  const fn = (e: Event) => {
    batch(() => handler(e))
  }
  el.addEventListener(event, fn)
  if (getOwner() !== undefined)
    onCleanup(() => el.removeEventListener(event, fn))
}
