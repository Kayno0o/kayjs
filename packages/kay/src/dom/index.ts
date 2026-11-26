// Kay v2 minimal DOM & hydration core (loop -> @kayjs/kay/internal/dom-loop, extras -> @kayjs/kay/internal/dom-extras for fine-grained chunk splitting).

import { isBlockedAttr, isStringBoolAttr, isUnsafeUrlAttr } from '../attrs'
import { batch, createOwner, disposeOwner, runWithOwner } from '../reactivity/index'
import { styleText } from '../style'
import { assertRenderable } from '../unrenderable'

export { isBlockedAttr } from '../attrs'
export { effect } from '../reactivity/index'

let hydrating = false
let hydrateNode: Node | null = null
let hydrateRoot: Element | null = null

export function claimLoop(parent: Node, fn: () => void, skip = 0, startMarker?: Node | null): boolean {
  if (!hydrating)
    return false
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
  hydrateNode = cur
  try {
    fn()
  }
  finally {
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
): { result: T, marker: Node | null, claimed: Node | null, nodes: Node[] | undefined } {
  if (!hydrating)
    return { result: fn(), marker, claimed: null, nodes: undefined }

  let claimed: Node | null
  if (startMarker !== undefined) {
    const first = startMarker === null ? parent.firstChild : startMarker.nextSibling
    claimed = first === marker ? null : first
  }
  else {
    claimed = marker === null ? parent.lastChild : marker.nodeType === 8 ? null : marker
  }
  const prevNode = hydrateNode
  hydrateNode = claimed
  let result: T
  let end: Node | null
  try {
    result = fn()
    end = hydrateNode
  }
  finally {
    hydrateNode = prevNode
  }
  if (startMarker !== undefined)
    return { result, marker, claimed, nodes: between(claimed, marker) }
  if (marker === null)
    return { result, marker: null, claimed, nodes: between(claimed, end) }
  if (claimed === null)
    return { result, marker, claimed, nodes: undefined }

  // The anchor goes after the claimed range; a text value or a nested insert moves no cursor and claims the one node.
  const consumed = end !== claimed
  const anchor = document.createComment('')
  ;(anchor as unknown as { __kayAnchor?: boolean }).__kayAnchor = true
  parent.insertBefore(anchor, consumed ? end : claimed.nextSibling)
  return { result, marker: anchor, claimed, nodes: consumed ? between(claimed, anchor) : undefined }
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
      // A node injected before the markup (an extension, a password manager) is stepped over; no matching node at all means the server rendered something else.
      let node: Node | null = stale
      while (node !== null && expectedTag !== undefined && node.nodeName.toLowerCase() !== expectedTag)
        node = node.nextSibling
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
    for (let i = 0; i < items.length; i++)
      render(items[i]!, i)
  }, skip, startMarker)) {
    return
  }
  const f = document.createDocumentFragment()
  for (let i = 0; i < items.length; i++)
    f.appendChild(render(items[i]!, i))
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
  else if (isUnsafeUrlAttr(name, value)) {
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
  let node = event.target as (Node & Record<string, ((e: Event) => void) | undefined>) | null
  let current: Node | null = null
  Object.defineProperty(event, 'currentTarget', { configurable: true, get: () => current })

  while (node !== null) {
    const handler = node[key]
    if (typeof handler === 'function') {
      current = node
      batch(() => handler(event))
      if (event.cancelBubble)
        return
    }
    node = node.parentNode as (Node & Record<string, ((e: Event) => void) | undefined>) | null
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
  el.addEventListener(event, (e) => {
    batch(() => handler(e))
  })
}
