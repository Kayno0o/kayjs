// Attribute, class, property and style bindings, in a module of their own (`dom-attrs`): only the islands that bind one load it.

import { isBlockedAttr, isStringBoolAttr, isUnsafeUrlAttr } from '../attrs'
import { styleText } from '../style'
import { assertRenderable } from '../unrenderable'

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
