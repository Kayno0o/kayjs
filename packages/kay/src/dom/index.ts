// Kay v2 minimal DOM & hydration core (loop -> kay/dom-loop, extras -> kay/dom-extras for fine-grained chunk splitting).

import { batch, createOwner, disposeOwner, runWithOwner } from '../reactivity/index'

export { effect } from '../reactivity/index'

let hydrating = false
let hydrateNode: Node | null = null

export function claimLoop(parent: Node, fn: () => void, skip = 0): boolean {
  if (!hydrating)
    return false
  const prevCursor = hydrateNode
  let cur = parent.firstChild
  for (let i = 0; i < skip && cur !== null; i++)
    cur = cur.nextSibling
  hydrateNode = cur
  try {
    fn()
  }
  finally {
    hydrateNode = prevCursor
  }
  return true
}

export function claimInsert<T>(parent: Node, marker: Node | null, fn: () => T): { result: T, marker: Node | null } {
  if (!hydrating)
    return { result: fn(), marker }

  let claimed: Node | null = marker !== null ? marker : parent.lastChild
  let nextMarker = marker
  if (marker !== null && marker.nodeType !== 8) {
    const anchor = document.createComment('')
    parent.insertBefore(anchor, marker.nextSibling)
    nextMarker = anchor
  }
  else if (marker !== null) {
    claimed = null
  }
  const prevNode = hydrateNode
  hydrateNode = claimed
  try {
    return { result: fn(), marker: nextMarker }
  }
  finally {
    hydrateNode = prevNode
  }
}

export function hydrate(container: Element, render: () => Node | DocumentFragment | null): () => void {
  const owner = createOwner(undefined)
  const prevHydrating = hydrating
  const prevNode = hydrateNode
  hydrating = true
  hydrateNode = container.firstChild

  try {
    runWithOwner(owner, () => {
      render()
    })
  }
  finally {
    hydrating = prevHydrating
    hydrateNode = prevNode
  }

  return () => disposeOwner(owner)
}

export function mount(container: Element, render: () => Node | DocumentFragment | null): () => void {
  const owner = createOwner(undefined)
  const prevHydrating = hydrating
  hydrating = false
  try {
    const node = runWithOwner(owner, render)
    container.textContent = ''
    if (node !== null)
      container.appendChild(node)
  }
  finally {
    hydrating = prevHydrating
  }
  return () => disposeOwner(owner)
}

export function template(html: string, isSvg?: boolean): () => Node {
  let cached: Node | undefined

  return (): Node => {
    if (hydrating && hydrateNode !== null) {
      const node = hydrateNode
      hydrateNode = node.nextSibling
      return node
    }

    if (cached === undefined) {
      const t = document.createElement('template')
      t.innerHTML = isSvg ? `<svg>${html}</svg>` : html
      cached = isSvg ? t.content.firstChild!.firstChild! : t.content.firstChild!
    }
    return cached.cloneNode(true)
  }
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
  if (claimLoop(parent, () => {
    for (let i = 0; i < items.length; i++)
      render(items[i]!, i)
  }, skip)) {
    return
  }
  const f = document.createDocumentFragment()
  for (let i = 0; i < items.length; i++)
    f.appendChild(render(items[i]!, i))
  parent.insertBefore(f, marker)
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

export function setText(node: Text, value: unknown): void {
  const str = value == null || typeof value === 'boolean' ? '' : String(value)
  if (node.data !== str)
    node.data = str
}

export function setClass(el: Element, value: unknown): void {
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
  if (value == null || value === false)
    el.removeAttribute(name)
  else if (value === true)
    el.setAttribute(name, '')
  else
    el.setAttribute(name, String(value))
}

export function setProp(el: Element, name: string, value: unknown): void {
  ;(el as unknown as Record<string, unknown>)[name] = value
}

export function setStyle(el: HTMLElement, value: unknown): void {
  if (value == null || value === false) {
    el.removeAttribute('style')
  }
  else if (typeof value === 'string') {
    el.style.cssText = value
  }
  else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      el.style.setProperty(k, v == null ? '' : String(v))
  }
}

// ---- Delegated events

const delegated = new Set<string>()

function dispatchEvent(event: Event): void {
  const key = `$$${event.type}`
  let node = event.target as (Node & Record<string, ((e: Event) => void) | undefined>) | null
  let current: Node | null = null
  Object.defineProperty(event, 'currentTarget', { configurable: true, get: () => current })

  while (node !== null) {
    const handler = node[key]
    if (handler !== undefined) {
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
  for (let i = 0; i < events.length; i++) {
    const type = events[i]!
    if (!delegated.has(type)) {
      delegated.add(type)
      document.addEventListener(type, dispatchEvent)
    }
  }
}

export function on(el: Node, event: string, handler: (e: Event) => void): void {
  el.addEventListener(event, (e) => {
    batch(() => handler(e))
  })
}
