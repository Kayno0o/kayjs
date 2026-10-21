import type { Drafts } from '../drafts'
import type { Field } from '../fields'
import type { EntryRef } from '../kay/contract'
import type { Direction } from './reorder'
import { wording } from 'kay/words'
import { emptyBlock, emptyValue, itemTitle } from '../fields'
import { entryKey, markersOf, parseMarker } from '../markers'
import { fieldOfMarker } from './inline'
import { reordered, targetOf } from './reorder'

// The lists an entry's page renders, on the page in edit mode: the element a `for` over a list fills carries `data-kay-list="<collection>:<slug>[@locale]:<path>"`, and each of its children is one item. The editor adds, removes and reorders the items in the entry's draft, as the form's list does, and the page renders the draft again.

type ListField = Field & { kind: 'list' }

export interface ListTarget extends EntryRef {
  path: string
}

export interface PageList {
  target: ListTarget
  field: ListField
  element: HTMLElement
}

export interface ItemHit {
  list: PageList
  index: number
  member: HTMLElement
}

// What the page shows to act on an item, or on an empty list when `index` is none.
export interface ListBar {
  key: string
  target: ListTarget
  index: number | undefined
  list: string
  item: string
  blocks: boolean
  count: number
  up: boolean
  down: boolean
  add: boolean
  remove: boolean
  style: string
}

// One of the answers a menu next to the page offers.
export interface Choice {
  key: string
  label: string
  run: () => void
}

export type PageListWatch = ReturnType<typeof watchLists>

export interface Removed {
  target: ListTarget
  at: number
  title: string
  value: unknown
}

const LIST_ATTRIBUTE = 'data-kay-list'

// The editor's own elements, whose changes and pointer are no business of the page's lists.
export const OWN = '.kcms-editor, .kcms-marks, .kcms-page-lists, .kcms-marker-menu, .kcms-inline-issue'
const BAR_TOP = 4
const BAR_GAP = 36

function targetOfElement(element: Element): ListTarget | undefined {
  const value = element.getAttribute(LIST_ATTRIBUTE)
  const marker = value === null ? undefined : parseMarker(value)

  return marker && typeof marker.path === 'string' ? { collection: marker.collection, slug: marker.slug, locale: marker.locale, path: marker.path } : undefined
}

// The list an element holds the items of, when the form knows its field.
export function pageListOf(element: Element, drafts: Drafts): PageList | undefined {
  const target = targetOfElement(element)

  if (!target || !(element instanceof HTMLElement))
    return undefined

  const field = fieldOfMarker(target, drafts)

  return field?.kind === 'list' ? { target, field, element } : undefined
}

export function itemsOf(drafts: Drafts, target: ListTarget): unknown[] {
  const value = drafts.value(target, target.path)

  return Array.isArray(value) ? value : []
}

// The place of a child of the list in its items, as the fields inside it name it.
function markedIndex(member: Element, target: ListTarget): number | undefined {
  const prefix = `${target.path}.`
  const key = entryKey(target)

  for (const element of [member, ...member.querySelectorAll('*')]) {
    for (const { marker } of markersOf(element)) {
      if (typeof marker.path !== 'string' || !marker.path.startsWith(prefix) || entryKey(marker) !== key)
        continue

      const index = Number.parseInt(marker.path.slice(prefix.length), 10)

      return Number.isInteger(index) ? index : undefined
    }
  }

  return undefined
}

// The place of a child of the list in its items: the one its fields name, else its position when the list renders one child per item.
function indexOfMember(member: HTMLElement, list: PageList, count: number): number | undefined {
  return markedIndex(member, list.target) ?? (count === list.element.children.length ? [...list.element.children].indexOf(member) : undefined)
}

// The list items holding the node, the innermost first. An entry whose draft the page does not show yet (it is not valid) has none, as the page's items may differ from the draft's.
export function itemsAround(node: Node, drafts: Drafts): ItemHit[] {
  const stale = drafts.stale()
  const hits: ItemHit[] = []

  for (let member: Element | null = node instanceof Element ? node : node.parentElement; member; member = member.parentElement) {
    const parent: HTMLElement | null = member.parentElement

    if (!parent?.hasAttribute(LIST_ATTRIBUTE) || !(member instanceof HTMLElement) || member.matches(OWN))
      continue

    const list = pageListOf(parent, drafts)

    if (!list || stale.some(entry => entryKey(entry) === entryKey(list.target)))
      continue

    const count = itemsOf(drafts, list.target).length
    const index = indexOfMember(member, list, count)

    if (index !== undefined && index < count)
      hits.push({ list, index, member })
  }

  return hits
}

// The lists of the page that hold no item, which a hover cannot reach.
export function emptyLists(drafts: Drafts): PageList[] {
  const found: PageList[] = []

  for (const element of document.querySelectorAll(`[${LIST_ATTRIBUTE}]`)) {
    if (element.childElementCount > 0 || element.closest(OWN))
      continue

    const list = pageListOf(element, drafts)

    if (list && itemsOf(drafts, list.target).length === 0)
      found.push(list)
  }

  return found
}

function sameItem(a: ItemHit, b: ItemHit): boolean {
  return a.list.element === b.list.element && a.index === b.index
}

function limits(list: PageList, count: number): { add: boolean, remove: boolean } {
  const { minItems, maxItems } = list.field

  return { add: maxItems === undefined || count < maxItems, remove: minItems === undefined || count > minItems }
}

function keyOf(target: ListTarget, index?: number): string {
  return `${entryKey(target)}:${target.path}:${index ?? 'new'}`
}

function inView(box: DOMRect): boolean {
  return box.width + box.height > 0 && box.bottom >= 0 && box.top <= innerHeight && box.right >= 0 && box.left <= innerWidth
}

// The bars for the items around the pointer and the focus, and for each empty list in view: next to the top right corner of an item, so a bar is reached from the item it acts on, and at the start of an empty list.
export function barsFor(anchors: Node[], drafts: Drafts): ListBar[] {
  const hits: ItemHit[] = []

  for (const anchor of anchors) {
    for (const hit of itemsAround(anchor, drafts)) {
      if (!hits.some(known => sameItem(known, hit)))
        hits.push(hit)
    }
  }

  const bars: ListBar[] = []

  for (const hit of hits) {
    const { list, index, member } = hit
    const box = member.getBoundingClientRect()

    if (!inView(box))
      continue

    const items = itemsOf(drafts, list.target)
    // Nested items stack their bars, the outer one lower, so none covers another.
    const level = hits.filter(other => other !== hit && member.contains(other.member)).length
    const top = Math.min(Math.max(box.top, 0), innerHeight - BAR_GAP) + BAR_TOP + level * BAR_GAP

    bars.push({
      key: keyOf(list.target, index),
      target: list.target,
      index,
      list: list.field.label,
      item: itemTitle(list.field, items[index], index),
      blocks: list.field.blocks !== undefined,
      count: items.length,
      up: targetOf('up', index, items.length) !== undefined,
      down: targetOf('down', index, items.length) !== undefined,
      ...limits(list, items.length),
      style: `top:${top}px;right:${innerWidth - Math.min(box.right, innerWidth) + BAR_TOP}px`,
    })
  }

  for (const list of emptyLists(drafts)) {
    const box = list.element.getBoundingClientRect()

    if (inView(box)) {
      bars.push({
        key: keyOf(list.target),
        target: list.target,
        index: undefined,
        list: list.field.label,
        item: '',
        blocks: list.field.blocks !== undefined,
        count: 0,
        up: false,
        down: false,
        ...limits(list, 0),
        style: `top:${Math.min(Math.max(box.top, 0), innerHeight - BAR_GAP) + BAR_TOP}px;left:${Math.max(box.left, 0) + BAR_TOP}px`,
      })
    }
  }

  return bars
}

// Gives the keyboard a way to an empty list, as a group named after its field, until the returned function is called. The page renders again and may fill them; what the page set itself is left alone.
export function reachEmptyLists(drafts: Drafts): { update: () => void, destroy: () => void } {
  const given = new Map<HTMLElement, string[]>()
  const take = (element: HTMLElement) => {
    for (const name of given.get(element) ?? [])
      element.removeAttribute(name)

    given.delete(element)
  }

  return {
    update() {
      const empty = new Set<HTMLElement>()

      for (const list of emptyLists(drafts)) {
        const { element } = list
        const label = wording('cms.pageList.empty', '{list}: no item yet, Enter adds one', { list: list.field.label })
        const names = given.get(element) ?? []

        empty.add(element)

        for (const [name, value] of [['tabindex', '0'], ['role', 'group'], ['aria-label', label]] as const) {
          if (!element.hasAttribute(name)) {
            element.setAttribute(name, value)
            names.push(name)
          }
          else if (name === 'aria-label' && names.includes(name) && element.getAttribute(name) !== value) {
            element.setAttribute(name, value)
          }
        }

        if (names.length > 0)
          given.set(element, names)
      }

      for (const element of given.keys()) {
        if (!empty.has(element))
          take(element)
      }
    },
    destroy() {
      for (const element of given.keys())
        take(element)
    },
  }
}

// Whether the element is an empty list the editor made reachable.
export function emptyListAt(element: Element, drafts: Drafts): PageList | undefined {
  return element.hasAttribute(LIST_ATTRIBUTE) && element.childElementCount === 0 ? pageListOf(element, drafts) : undefined
}

export function listFieldOf(target: ListTarget, drafts: Drafts): ListField | undefined {
  const field = fieldOfMarker(target, drafts)

  return field?.kind === 'list' ? field : undefined
}

// Puts a new item, of the block type `type` for a blocks list, in place at `at`; its place, or none when the list is full.
export function addItem(drafts: Drafts, target: ListTarget, at: number, type?: string): number | undefined {
  const field = listFieldOf(target, drafts)
  const items = itemsOf(drafts, target)

  if (!field || (field.maxItems !== undefined && items.length >= field.maxItems))
    return undefined

  const block = field.blocks?.find(found => found.type === type)
  const place = Math.max(0, Math.min(at, items.length))

  drafts.set(target, target.path, items.toSpliced(place, 0, block ? emptyBlock(block) : emptyValue(field.item)))

  return place
}

export function removeItem(drafts: Drafts, target: ListTarget, at: number): Removed | undefined {
  const field = listFieldOf(target, drafts)
  const items = itemsOf(drafts, target)

  if (!field || at < 0 || at >= items.length || (field.minItems !== undefined && items.length <= field.minItems))
    return undefined

  const removed = { target, at, title: itemTitle(field, items[at], at), value: items[at] }

  drafts.set(target, target.path, items.filter((_, place) => place !== at))

  return removed
}

// Moves the item one place, its new place or none at the end of the list.
export function moveItem(drafts: Drafts, target: ListTarget, from: number, direction: Direction): number | undefined {
  const items = itemsOf(drafts, target)
  const to = targetOf(direction, from, items.length)

  if (to === undefined)
    return undefined

  drafts.set(target, target.path, reordered(items, from, to))

  return to
}

// Puts a removed item back where it was, or at the end when the list got shorter.
export function restoreItem(drafts: Drafts, removed: Removed): number | undefined {
  const field = listFieldOf(removed.target, drafts)
  const items = itemsOf(drafts, removed.target)

  if (!field || (field.maxItems !== undefined && items.length >= field.maxItems))
    return undefined

  const place = Math.min(removed.at, items.length)

  drafts.set(removed.target, removed.target.path, items.toSpliced(place, 0, removed.value))

  return place
}

export function titleOf(drafts: Drafts, target: ListTarget, index: number): string {
  const field = listFieldOf(target, drafts)

  return field ? itemTitle(field, itemsOf(drafts, target)[index], index) : ''
}

export function blockChoices(list: ListTarget, drafts: Drafts): { type: string, label: string }[] {
  return listFieldOf(list, drafts)?.blocks?.map(block => ({ type: block.type, label: block.label })) ?? []
}

// The list element and the child at `index`, once the page shows them.
function memberAt(target: ListTarget, index: number): { list: HTMLElement | undefined, member: HTMLElement | undefined } {
  for (const element of document.querySelectorAll(`[${LIST_ATTRIBUTE}]`)) {
    const found = targetOfElement(element)

    if (!found || !(element instanceof HTMLElement) || entryKey(found) !== entryKey(target) || found.path !== target.path)
      continue

    const member = [...element.children].find((child): child is HTMLElement => child instanceof HTMLElement && markedIndex(child, target) === index)

    return { list: element, member }
  }

  return { list: undefined, member: undefined }
}

// Puts the keyboard focus on the item at `index` of the list (its first tab stop), else on the list when it is a tab stop, once the page shows it. Where it went: an item the page does not mark, such as a new empty text, has no element to take it.
export function focusItem(target: ListTarget, index: number): 'item' | 'list' | undefined {
  const { list, member } = memberAt(target, index)

  if (member) {
    const stop = member.matches('[tabindex]') ? member : member.querySelector<HTMLElement>('[tabindex]:not([tabindex="-1"]), a[href], button, input, select, textarea')
    const focusable = stop ?? member

    if (!focusable.hasAttribute('tabindex') && !focusable.matches('a[href], button, input, select, textarea'))
      focusable.setAttribute('tabindex', '-1')

    focusable.focus()

    return document.activeElement === focusable ? 'item' : undefined
  }

  list?.focus()

  return list && document.activeElement === list ? 'list' : undefined
}

// What is said of a move to a screen reader, as the form says it.
export function movedWords(item: string, to: number, count: number): string {
  return wording('cms.reorder.moved', 'Moved {item} to {position} of {count}', { item, position: to + 1, count })
}

// Keeps the bars for the items under the pointer and the focus, and for the empty lists, up to date as the page scrolls, resizes and renders again.
export function watchLists(drafts: Drafts, onBars: (bars: ListBar[]) => void): { hover: (node: Node | undefined, at?: { x: number, y: number }) => void, focus: (element: Element | undefined) => void, refresh: () => void, reach: () => void, destroy: () => void } {
  const reach = reachEmptyLists(drafts)
  const follow = new AbortController()
  let hovered: Node | undefined
  let point: { x: number, y: number } | undefined
  let focused: Element | undefined
  let frame = 0
  let shown = ''

  const compute = () => {
    frame = 0
    reach.update()

    // The page rendering again takes the element under the pointer away: whatever is under it now stands in.
    if (hovered && !hovered.isConnected)
      hovered = point ? document.elementFromPoint(point.x, point.y) ?? undefined : undefined

    if (focused && !focused.isConnected)
      focused = undefined

    const bars = barsFor([hovered, focused].filter(anchor => anchor !== undefined), drafts)
    const text = JSON.stringify(bars)

    if (text !== shown) {
      shown = text
      onBars(bars)
    }
  }
  const schedule = () => {
    if (frame === 0)
      frame = requestAnimationFrame(compute)
  }
  const observer = new MutationObserver((records) => {
    if (records.some(record => !(record.target instanceof Element ? record.target : record.target.parentElement)?.closest(OWN)))
      schedule()
  })

  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: [LIST_ATTRIBUTE] })
  addEventListener('scroll', schedule, { capture: true, passive: true, signal: follow.signal })
  addEventListener('resize', schedule, { passive: true, signal: follow.signal })
  schedule()

  return {
    hover(node, at) {
      hovered = node
      point = at
      schedule()
    },
    focus(element) {
      focused = element
      schedule()
    },
    refresh: schedule,
    reach: reach.update,
    destroy() {
      follow.abort()
      observer.disconnect()
      cancelAnimationFrame(frame)
      reach.destroy()
      onBars([])
    },
  }
}
