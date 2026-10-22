import { claiming, claimNode, component, createElement, insert, leavesInBrowser, listen, property, ref, setClass, setStyle, submits, unlisten } from './dom'
import { getOwner, renderEffect, runWithOwner } from './reactive'
import { attributeName, elementName, handlerName, merge, spreadAttributes } from './values'

// Spread attributes, and the dynamic tag that takes them: their own module, as it weighs on a page whose islands spread nothing.

// A link's spread props, getters kept, with the `target` and `rel` of a link leaving the site, unless it writes its own.
function outsideProps(props: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(props, 'target') || !leavesInBrowser(props.href))
    return props

  return merge(props, Object.hasOwn(props, 'rel') ? { target: '_blank' } : { target: '_blank', rel: 'noopener' })
}

// Attributes and handlers from objects only known at render time; with `content`, a `children`, `innerHTML` or `textContent` among them sets the element's content.
// `link` is for an `a`, whose attributes gain the `target` and `rel` of a link leaving the site.
export function spread(element: Element, sources: () => readonly object[], content = false, link = false): void {
  const set = new Map<string, unknown>()

  // Children render in a part of their own, so a change to another prop does not build them again.
  if (content)
    insert(element, null, null, () => merge(...sources()).children)

  // The handlers belong to the component, not to the effect a prop change runs again.
  const owner = getOwner()

  renderEffect(() => {
    const merged = merge(...sources())
    const props = link ? outsideProps(merged) : merged
    const seen = new Set<string>()

    for (const name of Object.keys(props)) {
      if (name === 'children' || !attributeName(name))
        continue

      const value = props[name]

      seen.add(name)

      if (set.get(name) === value)
        continue

      set.set(name, value)

      if (name === 'ref') {
        runWithOwner(owner, () => ref(element, value))
      }
      else if (handlerName(name) && typeof value === 'function') {
        runWithOwner(owner, () => (submits.listen ?? listen)(element, name, value as (event: Event) => void))
      }
      // A handler given as text runs as script, which the server never writes either.
      else if (handlerName(name)) {
        continue
      }
      // A function that is no handler, such as a slot given to the component, has no attribute form.
      else if (typeof value === 'function' && name !== 'class' && name !== 'style') {
        continue
      }
      else if (name === 'class') {
        setClass(element, value)
      }
      else if (name === 'style') {
        setStyle(element, value)
      }
      else {
        try {
          property(element, name, value, Object.hasOwn(props, 'hreflang'))
        }
        // A name the server writes but the browser refuses to set, such as `@click`.
        catch {}
      }
    }

    for (const [name, previous] of set) {
      if (seen.has(name))
        continue

      set.delete(name)

      if (handlerName(name) && typeof previous === 'function')
        unlisten(element, name)
      else if (name !== 'ref' && !handlerName(name))
        property(element, name, undefined)
    }
  })
}

// A component tag read off a prop or through a call: a string names an element, a function is the component.
export function dynamic(tag: unknown, props: Record<string, unknown>): unknown {
  if (typeof tag === 'function')
    return component(tag as (props: unknown) => unknown, props)

  if (typeof tag !== 'string')
    return null

  const element = claiming() ? claimNode() as Element : createElement(elementName(tag))

  spread(element, () => [spreadAttributes(props)], 'children' in props, element.localName === 'a')

  return element
}
