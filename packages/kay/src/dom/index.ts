// Kay v2 minimal DOM & hydration core (loop lives in kay/dom-loop so non-loop islands ship 0 bytes of reconciler).

import type { Owner } from '../reactivity/index'
import { batch, createOwner, disposeOwner, effect, getOwner, onCleanup, runWithOwner, untrack } from '../reactivity/index'

export { effect } from '../reactivity/index'

let hydrating = false
let hydrateNode: Node | null = null

export function claimLoop(parent: Node, fn: () => void): boolean {
  if (!hydrating)
    return false
  const prevCursor = hydrateNode
  hydrateNode = parent.firstChild
  try {
    fn()
  }
  finally {
    hydrateNode = prevCursor
  }
  return true
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

  while (node !== null) {
    const handler = node[key]
    if (handler !== undefined) {
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

const SPREAD_EVENT_RE = /^on([A-Z]\w*)$/
const SPREAD_DOM_PROPS = new Set(['value', 'checked', 'selected', 'muted', 'indeterminate'])

export function omit(props: Record<string, unknown>, excluded: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const skip = new Set(excluded)
  for (const key of Object.keys(props)) {
    if (skip.has(key))
      continue
    const desc = Object.getOwnPropertyDescriptor(props, key)
    if (desc !== undefined)
      Object.defineProperty(out, key, desc)
  }
  return out
}

export function spread(el: Element, getProps: () => Record<string, unknown> | null | undefined): void {
  let prevKeys: string[] = []
  const listeners = new Map<string, (e: Event) => void>()

  const removeListener = (ev: string) => {
    const fn = listeners.get(ev)
    if (fn !== undefined) {
      el.removeEventListener(ev, fn)
      listeners.delete(ev)
    }
  }

  onCleanup(() => {
    for (const [ev, fn] of listeners)
      el.removeEventListener(ev, fn)
    listeners.clear()
  })

  effect(() => {
    const props = getProps() ?? {}
    const nextKeys = Object.keys(props)

    for (let i = 0; i < prevKeys.length; i++) {
      const k = prevKeys[i]!
      if (k in props)
        continue
      const ev = SPREAD_EVENT_RE.exec(k)
      if (ev !== null) {
        removeListener(ev[1]!.toLowerCase())
      }
      else if (k === 'class' || k === 'className') {
        setClass(el, '')
      }
      else if (k === 'style') {
        setStyle(el as HTMLElement, null)
      }
      else if (k !== 'key' && k !== 'ref' && k !== '$hydrate' && k !== 'children') {
        el.removeAttribute(k === 'htmlFor' ? 'for' : k)
      }
    }

    for (let i = 0; i < nextKeys.length; i++) {
      const k = nextKeys[i]!
      if (k === 'key' || k === '$hydrate' || k === 'children')
        continue
      const v = props[k]
      if (k === 'ref') {
        if (typeof v === 'function')
          (v as (node: Element) => void)(el)
        continue
      }
      const ev = SPREAD_EVENT_RE.exec(k)
      if (ev !== null) {
        const type = ev[1]!.toLowerCase()
        removeListener(type)
        if (typeof v === 'function') {
          const wrapped = (e: Event) => batch(() => (v as (ev: Event) => void)(e))
          listeners.set(type, wrapped)
          el.addEventListener(type, wrapped)
        }
        continue
      }
      const name = k === 'className' ? 'class' : k === 'htmlFor' ? 'for' : k
      if (name === 'class')
        setClass(el, v)
      else if (name === 'style')
        setStyle(el as HTMLElement, v)
      else if (SPREAD_DOM_PROPS.has(name))
        setProp(el, name, v)
      else
        setAttr(el, name, v)
    }

    prevKeys = nextKeys
  })
}

// ---- Dynamic insertion & conditional show

export function insert(parent: Node, value: () => unknown, marker: Node | null = null): void {
  let current: Node | Node[] | null = null
  let textNode: Text | undefined

  effect(() => {
    const next = value()

    if (next == null || typeof next === 'boolean') {
      clearInserted(current)
      current = null
      if (textNode !== undefined)
        textNode.data = ''
      return
    }

    if (typeof next === 'string' || typeof next === 'number') {
      const str = String(next)
      if (current !== null) {
        clearInserted(current)
        current = null
      }
      if (textNode === undefined) {
        textNode = document.createTextNode(str)
        parent.insertBefore(textNode, marker)
      }
      else if (textNode.data !== str) {
        textNode.data = str
      }
      return
    }

    if (textNode !== undefined) {
      textNode.remove()
      textNode = undefined
    }

    if (next instanceof Node) {
      if (current === next)
        return
      if (current === null && next.parentNode === parent) {
        current = next
        return
      }
      clearInserted(current)
      if (next.nodeType === 11) {
        const nodes = Array.from(next.childNodes)
        parent.insertBefore(next, marker)
        current = nodes
      }
      else {
        parent.insertBefore(next, marker)
        current = next
      }
      return
    }

    if (Array.isArray(next)) {
      clearInserted(current)
      const f = document.createDocumentFragment()
      const nodes: Node[] = []
      for (let i = 0; i < next.length; i++) {
        const item = next[i]
        if (item instanceof Node) {
          if (item.nodeType === 11)
            nodes.push(...Array.from(item.childNodes))
          else
            nodes.push(item)
          f.appendChild(item)
        }
        else if (item != null && typeof item !== 'boolean') {
          const t = document.createTextNode(String(item))
          nodes.push(t)
          f.appendChild(t)
        }
      }
      parent.insertBefore(f, marker)
      current = nodes
    }
  })
}

function clearInserted(current: Node | Node[] | null): void {
  if (current === null)
    return
  if (Array.isArray(current)) {
    for (let i = 0; i < current.length; i++)
      current[i]!.parentNode?.removeChild(current[i]!)
  }
  else {
    current.parentNode?.removeChild(current)
  }
}

export function show(
  parent: Node,
  marker: Node | null,
  when: () => unknown,
  renderTrue: () => Node | null,
  renderFalse?: () => Node | null,
): void {
  const parentOwner = getOwner()
  let branch: 0 | 1 | 2 = 0
  let owner: Owner | undefined
  let nodes: Node[] = []

  const clear = () => {
    if (owner !== undefined) {
      disposeOwner(owner)
      owner = undefined
    }
    for (let i = 0; i < nodes.length; i++)
      nodes[i]!.parentNode?.removeChild(nodes[i]!)
    nodes = []
  }

  effect(() => {
    const cond = Boolean(when())
    const nextBranch: 1 | 2 = cond ? 1 : 2
    if (branch === nextBranch)
      return

    clear()
    branch = nextBranch

    const fn = cond ? renderTrue : renderFalse
    if (fn === undefined)
      return

    owner = createOwner(parentOwner)
    const rendered = untrack(() => runWithOwner(owner, fn))
    if (rendered === null)
      return

    if (rendered.nodeType === 11) {
      nodes = Array.from(rendered.childNodes)
      parent.insertBefore(rendered, marker)
    }
    else {
      nodes = [rendered]
      parent.insertBefore(rendered, marker)
    }
  })
}
