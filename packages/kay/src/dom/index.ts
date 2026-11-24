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
  for (let i = 0; i < skip && cur !== null; i++) {
    cur = cur.nextSibling
    while (cur !== null && (cur as unknown as { __kayAnchor?: boolean }).__kayAnchor === true)
      cur = cur.nextSibling
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

// `nodes` is the SSR range the render claimed through template() (a fragment hydrates to null, so the caller learns its nodes here).
export function claimInsert<T>(
  parent: Node,
  marker: Node | null,
  fn: () => T,
  startMarker?: Node | null,
): { result: T, marker: Node | null, claimed: Node | null, nodes: Node[] | undefined } {
  if (!hydrating)
    return { result: fn(), marker, claimed: null, nodes: undefined }

  if (startMarker !== undefined) {
    const first = startMarker === null ? parent.firstChild : startMarker.nextSibling
    const claimed = first === marker ? null : first
    const prevNode = hydrateNode
    hydrateNode = claimed
    let result: T
    try {
      result = fn()
    }
    finally {
      hydrateNode = prevNode
    }
    const nodes: Node[] = []
    for (let n: Node | null = claimed; n !== null && n !== marker; n = n.nextSibling)
      nodes.push(n)
    return { result, marker, claimed, nodes: nodes.length > 0 ? nodes : undefined }
  }

  const claimed: Node | null = marker === null ? parent.lastChild : marker.nodeType === 8 ? null : marker
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
  if (marker === null) {
    let nodes: Node[] | undefined
    if (claimed !== null && end !== claimed) {
      nodes = []
      for (let n: Node | null = claimed; n !== null && n !== end; n = n.nextSibling)
        nodes.push(n)
    }
    return { result, marker: null, claimed, nodes }
  }
  if (claimed === null)
    return { result, marker, claimed, nodes: undefined }

  // The anchor goes after the claimed range; a text value or a nested insert moves no cursor and claims the one node.
  const consumed = end !== claimed
  const anchor = document.createComment('')
  ;(anchor as unknown as { __kayAnchor?: boolean }).__kayAnchor = true
  parent.insertBefore(anchor, consumed ? end : claimed.nextSibling)
  let nodes: Node[] | undefined
  if (consumed) {
    nodes = []
    for (let n: Node | null = claimed; n !== null && n !== anchor; n = n.nextSibling)
      nodes.push(n)
  }
  return { result, marker: anchor, claimed, nodes }
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
  catch (err) {
    disposeOwner(owner)
    throw err
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
  catch (err) {
    disposeOwner(owner)
    throw err
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

/** Advance past an optional SSR text node (`<!-->text<!-->` or `<!--><!-->`) to the closing comment marker. */
export function skipText(marker: Node): Node | null {
  const next = marker.nextSibling
  return next !== null && next.nodeType === 3 ? next.nextSibling : next
}

/** Advance past an SSR-bracketed dynamic range (`<!---->...<!---->`) to its closing comment marker. */
export function skipRange(marker: Node): Node | null {
  let cur = marker.nextSibling
  while (cur !== null && cur.nodeType !== 8)
    cur = cur.nextSibling
  return cur
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

const VALID_ATTR_NAME = /^[A-Za-z_:][-\w:.]*$/
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href'])
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i
const STRING_BOOL_ATTRS = new Set(['draggable', 'spellcheck', 'contenteditable'])

function isBlockedAttr(name: string): boolean {
  if (!VALID_ATTR_NAME.test(name))
    return true
  const lower = name.toLowerCase()
  return lower.startsWith('on') || lower === 'innerhtml' || lower === 'srcdoc'
}

function isStringBoolAttr(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('aria-') || STRING_BOOL_ATTRS.has(lower)
}

function isUnsafeUrlAttr(name: string, value: unknown): boolean {
  if (!URL_ATTRS.has(name.toLowerCase()))
    return false
  return UNSAFE_URL_RE.test(String(value).replace(/[\u0000-\u0020]+/g, ''))
}

export function setAttr(el: Element, name: string, value: unknown): void {
  if (isBlockedAttr(name))
    return
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
