// Kay v2 minimal DOM & hydration core. Every island imports it, so what only some islands need lives apart: attribute bindings in @kayjs/kay/internal/dom-attrs, claiming SSR lists and inserts in dom-claim, lists in dom-loop, inserts and spreads in dom-extras.

import { batch, createOwner, disposeOwner, getOwner, onCleanup, runWithOwner } from '../reactivity/index'
import { assertRenderable } from '../unrenderable'

export { effect } from '../reactivity/index'

let hydrating = false
let hydrateNode: Node | null = null
let hydrateRoot: Element | null = null

export function isRangeEnd(node: Node): boolean {
  return node.nodeType === 8 && (node as Comment).data === 'k]'
}

export function hydrateCursor(): Node | null {
  return hydrating ? hydrateNode : null
}

export function isHydrating(): boolean {
  return hydrating
}

/** Points the hydration cursor at `node` (claiming SSR nodes when `on`) and returns the cursor it replaced, for the caller to restore. */
export function moveCursor(on: boolean, node: Node | null): [boolean, Node | null] {
  const prev: [boolean, Node | null] = [hydrating, hydrateNode]
  hydrating = on
  hydrateNode = node
  return prev
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
