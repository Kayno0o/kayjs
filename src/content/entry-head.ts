import type { HeadTag } from '../runtime/head'
import type { Collection, Entry } from './index'
import { descriptionOf } from './excerpt'

// The fields an entry's page date is read from, after the collection's `publishAt`.
const DATE_FIELDS = ['date', 'publishedAt', 'published']

// What a collection says of where an entry's dates are.
interface DateFields {
  options: { publishAt?: string | undefined, modified?: string | undefined }
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function dateOf(value: unknown): Date | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined
}

// When an entry was published: the collection's `publishAt`, else `date`, `publishedAt` or `published`.
export function entryPublished(collection: DateFields, entry: Entry<unknown>): Date | undefined {
  const data = dataOf(entry)

  return [collection.options.publishAt, ...DATE_FIELDS].map(field => field === undefined ? undefined : dateOf(data[field])).find(date => date !== undefined)
}

// When an entry last changed: the collection's `modified` field, its file's time or last commit for `'mtime'` and `'git'`, or undefined for an entry with none.
export function entryModified(collection: DateFields, entry: Entry<unknown>): Date | undefined {
  const { modified } = collection.options

  return modified === undefined ? undefined : dateOf(entry.modified) ?? dateOf(dataOf(entry)[modified])
}

export function dataOf(entry: Entry<unknown>): Record<string, unknown> {
  return (typeof entry.data === 'object' && entry.data !== null ? entry.data : {}) as Record<string, unknown>
}

function meta(key: 'name' | 'property', name: string, content: string): HeadTag {
  return { tag: 'meta', props: { [key]: name, content } }
}

// What an entry's own page puts in its head: the `title` and `description` of its data, and for one with a date (the collection's `publishAt`, else `date`, `publishedAt` or `published`) an article: `og:type` and `article:published_time`, with `article:modified_time` when the collection's `modified` field holds another date.
// The page's own `head` tags replace each of them.
export function entryHead(collection: Collection<unknown>, entry: Entry<unknown>): HeadTag[] {
  const data = dataOf(entry)
  const title = text(data.title)
  const description = text(data.description) ?? descriptionOf(entry.excerpt)
  const published = entryPublished(collection, entry)
  const modified = entryModified(collection, entry)

  return [
    ...title === undefined ? [] : [{ tag: 'title', props: { children: title } }],
    ...description === undefined ? [] : [meta('name', 'description', description)],
    ...published === undefined ? [] : [meta('property', 'og:type', 'article'), meta('property', 'article:published_time', published.toISOString())],
    ...modified === undefined || modified.getTime() === published?.getTime() ? [] : [meta('property', 'article:modified_time', modified.toISOString())],
  ]
}
