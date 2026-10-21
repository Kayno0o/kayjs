import type { TSchema } from 'elysia'
import type { Entry } from './index'
import { KayError } from '../compiler/errors'

// Whether the collection's `draft` holds an entry back: its function, or its boolean field set.
export function isDraft<Data>(draft: ((entry: Entry<Data>) => boolean) | string, entry: Entry<Data>): boolean {
  return typeof draft === 'string' ? (entry.data as Record<string, unknown> | undefined)?.[draft] === true : draft(entry)
}

// When the entry's `publishAt` or `unpublishAt` field says it goes live or down, in milliseconds, or undefined for an entry with no date.
export function publishTime(field: string, entry: Entry<unknown>): number | undefined {
  const value = (entry.data as Record<string, unknown> | undefined)?.[field]
  const time = value instanceof Date ? value.getTime() : Number.NaN

  return Number.isNaN(time) ? undefined : time
}

interface Node {
  type?: unknown
  anyOf?: Node[]
}

function holdsDate(node: Node): boolean {
  return node.type === 'Date' || (node.anyOf?.some(holdsDate) ?? false)
}

// A `publishAt` or `unpublishAt` naming anything but an `s.Date()` field would hold nothing back, so it fails where the collection is made.
export function checkPublishField(name: string, schema: TSchema, field: string, option: 'publishAt' | 'unpublishAt'): void {
  const node = (schema as { properties?: Record<string, Node> }).properties?.[field]

  if (node === undefined || !holdsDate(node))
    throw new KayError('config-invalid', `kay: the collection ${name}'s ${option} names ${field}, which is not an s.Date() field of its schema`)
}
