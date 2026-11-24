// Optional DOM helpers (spread, omit, insert, show, setInnerHtml) split into a separate module
// so Bun.build({ splitting: true }) keeps them out of minimal islands that don't use them.

import type { Owner } from '../reactivity/index'
import { batch, createOwner, disposeOwner, effect, getOwner, onCleanup, runWithOwner, untrack } from '../reactivity/index'
import { claimInsert, setAttr, setClass, setProp, setStyle } from './index'

export function setInnerHtml(el: Element, value: unknown): void {
  const html = value == null || value === false
    ? ''
    : (typeof value === 'object' && '__html' in value ? String((value as { __html: string }).__html) : String(value))
  if (el.innerHTML !== html)
    el.innerHTML = html
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
      if (name === 'innerHTML')
        setInnerHtml(el, v)
      else if (name === 'class')
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

export function insert(parent: Node, value: () => unknown, marker: Node | null = null): void {
  let current: Node | Node[] | null = null
  let textNode: Text | undefined

  effect(() => {
    const res = claimInsert(parent, marker, value)
    marker = res.marker
    const next = res.result

    if (next == null && res.nodes !== undefined) {
      current = res.nodes
      return
    }

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
        const claimed = claimTextNode(res.claimed, str)
        if (claimed !== undefined) {
          textNode = claimed
        }
        else {
          textNode = document.createTextNode(str)
          parent.insertBefore(textNode, marker)
        }
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
    const res = claimInsert(parent, marker, () => untrack(() => runWithOwner(owner, fn)))
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
      const f = document.createDocumentFragment()
      const list: Node[] = []
      for (let i = 0; i < rendered.length; i++) {
        const item = rendered[i]
        if (item instanceof Node) {
          if (item.nodeType === 11)
            list.push(...Array.from(item.childNodes))
          else
            list.push(item)
          f.appendChild(item)
        }
        else if (item != null && typeof item !== 'boolean') {
          const str = String(item)
          if (str !== '') {
            const t = document.createTextNode(str)
            list.push(t)
            f.appendChild(t)
          }
        }
      }
      parent.insertBefore(f, marker)
      nodes = list
    }
  })
}
