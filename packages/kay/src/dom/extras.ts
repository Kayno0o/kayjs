// Optional DOM helpers (spread, omit, insert, show, setInnerHtml) split into a separate module
// so Bun.build({ splitting: true }) keeps them out of minimal islands that don't use them.

import type { Owner } from '../reactivity/index'
import { DOM_PROPS } from '../attrs'
import { batch, createOwner, disposeOwner, effect, getOwner, onCleanup, runWithOwner, untrack } from '../reactivity/index'
import { assertRenderable } from '../unrenderable'
import { claimInsert, claimRange, isBlockedAttr, setAttr, setClass, setProp, setStyle, skipRange } from './index'

const RAW_HTML = Symbol.for('kay.html')

function isRawHtml(value: unknown): value is { __html: string } {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RAW_HTML] === true && '__html' in value
}

export function setInnerHtml(el: Element, value: unknown): void {
  let html: string
  if (value == null || value === false)
    html = ''
  else if (isRawHtml(value))
    html = String(value.__html)
  else if (typeof value === 'object' && '__html' in value)
    throw new TypeError('kay: innerHTML takes the HTML string, got a { __html } object; pass the string, or raw(html) for a value typed Html.')
  else
    html = String(value)
  if (el.innerHTML !== html)
    el.innerHTML = html
}

const EVENT_PROP = /^on([A-Z]\w*)$/

/** Merges prop objects while preserving getter descriptors so reactive props stay lazy across component spreads. */
export function mergeProps(...sources: (Record<string, unknown> | null | undefined)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    if (src == null || typeof src !== 'object')
      continue
    const keys = Object.keys(src)
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!
      const desc = Object.getOwnPropertyDescriptor(src, key)
      if (desc !== undefined)
        Object.defineProperty(out, key, desc)
    }
  }
  return out
}

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
  let lastRef: unknown
  // One listener per event type, calling whichever handler the props hold now.
  const handlers = new Map<string, (e: Event) => void>()
  const listen = (e: Event): void => {
    const handler = handlers.get(e.type)
    if (handler !== undefined)
      batch(() => handler(e))
  }

  onCleanup(() => {
    for (const type of handlers.keys())
      el.removeEventListener(type, listen)
    handlers.clear()
  })

  effect(() => {
    const types = new Set<string>()
    const props = getProps() ?? {}
    const nextKeys = Object.keys(props)

    for (let i = 0; i < prevKeys.length; i++) {
      const k = prevKeys[i]!
      if (k in props)
        continue
      if (k === 'class' || k === 'className') {
        setClass(el, '')
      }
      else if (k === 'style') {
        setStyle(el as HTMLElement, null)
      }
      else if (k !== 'key' && k !== 'ref' && k !== '$hydrate' && k !== 'children') {
        const name = k === 'htmlFor' ? 'for' : k
        if (!isBlockedAttr(name)) {
          if (DOM_PROPS.has(name))
            setProp(el, name, name === 'value' ? '' : false)
          el.removeAttribute(name)
        }
      }
    }

    for (let i = 0; i < nextKeys.length; i++) {
      const k = nextKeys[i]!
      if (k === 'key' || k === '$hydrate' || k === 'children')
        continue
      if (k === 'dangerouslySetInnerHTML')
        throw new TypeError('kay: dangerouslySetInnerHTML in a spread: write innerHTML={html} on the element.')
      const v = props[k]
      if (k === 'ref') {
        if (typeof v === 'function' && v !== lastRef) {
          lastRef = v
          ;(v as (node: Element) => void)(el)
        }
        continue
      }
      const event = typeof v === 'function' ? EVENT_PROP.exec(k) : null
      if (event !== null) {
        const type = event[1]!.toLowerCase()
        types.add(type)
        el.addEventListener(type, listen)
        handlers.set(type, v as (e: Event) => void)
        continue
      }
      const name = k === 'className' ? 'class' : k === 'htmlFor' ? 'for' : k
      if (isBlockedAttr(name))
        continue
      if (name === 'class')
        setClass(el, v)
      else if (name === 'style')
        setStyle(el as HTMLElement, v)
      else if (DOM_PROPS.has(name))
        setProp(el, name, v)
      else
        setAttr(el, name, v)
    }

    for (const type of handlers.keys()) {
      if (!types.has(type)) {
        handlers.delete(type)
        el.removeEventListener(type, listen)
      }
    }
    prevKeys = nextKeys
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

// Inserts the nodes and texts of a rendered array before the marker; a fragment contributes its children.
function insertAll(parent: Node, marker: Node | null, items: unknown[]): Node[] {
  const f = document.createDocumentFragment()
  const nodes: Node[] = []
  for (const item of items) {
    if (item instanceof Node) {
      if (item.nodeType === 11)
        nodes.push(...Array.from(item.childNodes))
      else
        nodes.push(item)
      f.appendChild(item)
    }
    else if (item != null && typeof item !== 'boolean' && item !== '') {
      const t = document.createTextNode(String(item))
      nodes.push(t)
      f.appendChild(t)
    }
  }
  parent.insertBefore(f, marker)
  return nodes
}

function claimTextNode(claimed: Node | null, str: string): Text | undefined {
  if (claimed === null || claimed.nodeType !== 3)
    return undefined
  const text = claimed as Text
  if (text.data === str)
    return text
  if (str.length > 0 && text.data.endsWith(str))
    return text.splitText(text.data.length - str.length)
  return undefined
}

export function insert(parent: Node, value: () => unknown, marker: Node | null = null, startMarker?: Node | null): void {
  let current: Node | Node[] | null = null
  let textNode: Text | undefined
  let firstRun = true

  effect(() => {
    let res: { result: unknown, marker: Node | null, claimed: Node | null, nodes: Node[] | undefined }
    if (firstRun) {
      firstRun = false
      let effMarker = marker
      let effStart = startMarker
      if (effStart === undefined && effMarker !== null && effMarker.nodeType === 8) {
        const close = skipRange(effMarker)
        if (close !== null) {
          effStart = effMarker
          effMarker = close
        }
      }
      res = claimInsert(parent, effMarker, value, effStart)
      marker = res.marker
    }
    else {
      res = { result: value(), marker, claimed: null, nodes: undefined }
    }
    const next = res.result
    const ssrNodes = res.nodes
    // An insert born in a fragment follows its marker into the parent the fragment was appended to.
    const host = marker?.parentNode ?? parent

    if (next == null && ssrNodes !== undefined) {
      current = ssrNodes
      return
    }

    if (next == null || typeof next === 'boolean') {
      clearInserted(current)
      if (ssrNodes !== undefined)
        clearInserted(ssrNodes)
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
        const claimed = claimTextNode(res.claimed, str)
        if (claimed !== undefined) {
          textNode = claimed
          if (ssrNodes !== undefined)
            clearInserted(ssrNodes.filter(n => n !== claimed))
        }
        else {
          if (ssrNodes !== undefined)
            clearInserted(ssrNodes)
          textNode = document.createTextNode(str)
          host.insertBefore(textNode, marker)
        }
      }
      else if (textNode.data !== str) {
        textNode.data = str
      }
      return
    }

    if (process.env.NODE_ENV !== 'production') {
      if (isRawHtml(next))
        throw new TypeError('kay: raw() HTML cannot be a dynamic child in the browser; set it with innerHTML={html} on an element.')
      assertRenderable(next, 'text')
    }

    if (textNode !== undefined) {
      textNode.remove()
      textNode = undefined
    }

    if (next instanceof Node) {
      if (current === next)
        return
      if (current === null && next.parentNode === host) {
        if (ssrNodes !== undefined)
          clearInserted(ssrNodes.filter(n => n !== next))
        current = next
        return
      }
      clearInserted(current)
      if (ssrNodes !== undefined)
        clearInserted(ssrNodes)
      if (next.nodeType === 11) {
        const nodes = Array.from(next.childNodes)
        host.insertBefore(next, marker)
        current = nodes
      }
      else {
        host.insertBefore(next, marker)
        current = next
      }
      return
    }

    if (Array.isArray(next)) {
      clearInserted(current)
      if (ssrNodes !== undefined) {
        const kept = new Set(next)
        clearInserted(ssrNodes.filter(n => !kept.has(n)))
      }
      current = insertAll(host, marker, next)
    }
  })
}

// A dynamic child of a root fragment: hydrates against its SSR range, or renders before a comment anchor that travels with the fragment.
export function fragInsert(value: () => unknown): Node | null {
  const start = claimRange()
  if (start !== null) {
    insert(start.parentNode!, value, start)
    return null
  }
  const f = document.createDocumentFragment()
  const anchor = f.appendChild(document.createComment(''))
  insert(f, value, anchor)
  return f
}

export function show(
  parent: Node,
  marker: Node | null,
  when: () => unknown,
  renderTrue: () => unknown,
  renderFalse?: () => unknown,
): void {
  const parentOwner = getOwner()
  let branch: 0 | 1 | 2 = 0
  let owner: Owner | undefined
  let nodes: Node[] = []
  let firstRun = true

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

    clear()
    branch = nextBranch

    const fn = cond ? renderTrue : renderFalse
    if (fn === undefined)
      return

    owner = createOwner(parentOwner)
    const res = claimInsert(parent, marker, () => untrack(() => runWithOwner(owner, fn)), startMarker)
    marker = res.marker
    const rendered = res.result
    if (rendered == null || typeof rendered === 'boolean') {
      nodes = res.nodes ?? []
      return
    }

    if (typeof rendered === 'string' || typeof rendered === 'number') {
      const str = String(rendered)
      if (str === '')
        return
      const text = claimTextNode(res.claimed, str) ?? document.createTextNode(str)
      if (text.parentNode !== parent)
        parent.insertBefore(text, marker)
      nodes = [text]
      return
    }

    if (rendered instanceof Node) {
      if (rendered.nodeType === 11) {
        nodes = Array.from(rendered.childNodes)
        parent.insertBefore(rendered, marker)
      }
      else {
        nodes = [rendered]
        if (rendered.parentNode !== parent)
          parent.insertBefore(rendered, marker)
      }
      return
    }

    if (Array.isArray(rendered)) {
      nodes = insertAll(parent, marker, rendered)
    }
  })
}
