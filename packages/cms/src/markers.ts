import type { EntryRef } from './kay/contract'

// kay's edit-mode markers (kaynooo/kayjs#262): `data-kay-field="posts:hello@fr:sections.1.heading"` on an element whose text is the field, `data-kay-field-src` and the like for a field rendered in an attribute, a `<!--kay-field posts:hello:author-->` ... `<!--/kay-field-->` pair around a field sharing its element's text with others, and `data-kay-body="posts:hello"` or a `kay-body` pair around a Markdown body.

// The path of an entry's Markdown body, which no data key can take.
export const BODY = Symbol('body')

export type FieldPath = string | typeof BODY

export interface FieldMarker extends EntryRef {
  path: FieldPath
}

export interface MarkedField {
  marker: FieldMarker
  element: Element
  // The attribute the field renders in, for a `data-kay-field-<attribute>` marker.
  attribute?: string | undefined
  // The opening comment of a comment pair marker.
  start?: Comment | undefined
}

const FIELD_ATTRIBUTE = 'data-kay-field'
const BODY_ATTRIBUTE = 'data-kay-body'
const ATTRIBUTE_PREFIX = `${FIELD_ATTRIBUTE}-`
const OPEN_COMMENT = /^kay-(field|body) (.+)$/
const CLOSE_COMMENT = /^\/kay-(?:field|body)$/

export function entryKey({ collection, slug, locale }: EntryRef): string {
  const entry = encodeURIComponent(slug) + (locale === undefined ? '' : `@${encodeURIComponent(locale)}`)

  return `${encodeURIComponent(collection)}:${entry}`
}

export function formatMarker(marker: FieldMarker): string {
  return marker.path === BODY ? entryKey(marker) : `${entryKey(marker)}:${encodeURIComponent(marker.path)}`
}

// Reads a `data-kay-field` value, or a `data-kay-body` one when `body` is set.
export function parseMarker(value: string, body = false): FieldMarker | undefined {
  const [collection, entry, path, ...extra] = value.split(':')

  if (!collection || !entry || (body ? path !== undefined : path === undefined) || extra.length > 0)
    return undefined

  const [slug, locale, ...more] = entry.split('@')

  if (!slug || more.length > 0)
    return undefined

  try {
    const marker: FieldMarker = { collection: decodeURIComponent(collection), slug: decodeURIComponent(slug), path: path === undefined ? BODY : decodeURIComponent(path) }

    return locale === undefined ? marker : { ...marker, locale: decodeURIComponent(locale) }
  }
  catch {
    return undefined
  }
}

// The fields rendered at `node`, innermost first: an element's own markers win over a comment pair around it, which wins over its parents'.
export function fieldsAt(node: Node): MarkedField[] {
  for (let current: Node | null = node; current; current = current.parentNode) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const own = markersOf(current as Element)

      if (own.length > 0)
        return own
    }

    const start = openingComment(current)
    const [, kind, value] = start?.data.trim().match(OPEN_COMMENT) ?? []
    const marker = value === undefined ? undefined : parseMarker(value, kind === 'body')

    if (start?.parentElement && marker)
      return [{ marker, element: start.parentElement, start }]
  }

  return []
}

function markersOf(element: Element): MarkedField[] {
  const found: MarkedField[] = []

  for (const { name, value } of element.attributes) {
    const marker = name === FIELD_ATTRIBUTE || name === BODY_ATTRIBUTE || name.startsWith(ATTRIBUTE_PREFIX) ? parseMarker(value, name === BODY_ATTRIBUTE) : undefined

    if (marker)
      found.push(name.startsWith(ATTRIBUTE_PREFIX) ? { marker, element, attribute: name.slice(ATTRIBUTE_PREFIX.length) } : { marker, element })
  }

  return found
}

// The marker comment opened before `node` among its siblings and not closed before it.
function openingComment(node: Node): Comment | undefined {
  for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
    if (sibling.nodeType !== Node.COMMENT_NODE)
      continue

    const data = (sibling as Comment).data.trim()

    if (CLOSE_COMMENT.test(data))
      return undefined

    if (OPEN_COMMENT.test(data))
      return sibling as Comment
  }

  return undefined
}
