import type { HeadTag } from '../runtime/head'
import type { Collection, Entry } from './index'

// The fields an entry's page date is read from, after the collection's `publishAt`.
const DATE_FIELDS = ['date', 'publishedAt', 'published']

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function dateOf(value: unknown): Date | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : undefined
}

function meta(key: 'name' | 'property', name: string, content: string): HeadTag {
  return { tag: 'meta', props: { [key]: name, content } }
}

// What an entry's own page puts in its head: the `title` and `description` of its data, and for one with a date (the collection's `publishAt`, else `date`, `publishedAt` or `published`) an article: `og:type` and `article:published_time`.
// The page's own `head` tags replace each of them.
export function entryHead(collection: Collection<unknown>, entry: Entry<unknown>): HeadTag[] {
  const data = (typeof entry.data === 'object' && entry.data !== null ? entry.data : {}) as Record<string, unknown>
  const title = text(data.title)
  const description = text(data.description)
  const published = [collection.options.publishAt, ...DATE_FIELDS].map(field => field === undefined ? undefined : dateOf(data[field])).find(date => date !== undefined)

  return [
    ...title === undefined ? [] : [{ tag: 'title', props: { children: title } }],
    ...description === undefined ? [] : [meta('name', 'description', description)],
    ...published === undefined ? [] : [meta('property', 'og:type', 'article'), meta('property', 'article:published_time', published.toISOString())],
  ]
}
