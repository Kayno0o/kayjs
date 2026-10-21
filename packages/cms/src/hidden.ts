import type { ContentLoader } from 'kay/content'
import { collectionLoader } from './kay/content'
import { settings } from './settings'

// The hidden collections of each loader, made once as a loader opens its table and starts its watcher on first use.
const kept = new WeakMap<ContentLoader, Map<string, ContentLoader>>()

// The hidden collection of that kind (`history`, `trash`) beside a loaded collection's entries, written through its own loader; undefined when `cms({ history })` or the collection's `history` is off, the collection is a folder's or its loader has no `sibling`.
export function hiddenOf(collection: string, kind: 'history' | 'trash'): ContentLoader | undefined {
  if (settings().history === undefined || settings().layouts.get(collection)?.history === false || (kind === 'trash' && settings().history?.trash === undefined))
    return undefined

  const loader = collectionLoader(collection)

  if (loader?.sibling === undefined)
    return undefined

  const siblings = kept.get(loader) ?? new Map<string, ContentLoader>()
  let sibling = siblings.get(kind)

  if (sibling === undefined) {
    sibling = loader.sibling(kind)
    siblings.set(kind, sibling)
    kept.set(loader, siblings)
  }

  return sibling
}

// The row of a place in a hidden collection, whether or not its loader answers one place alone.
export async function rowOf(hidden: ContentLoader, place: string): Promise<{ data: unknown, body?: string | undefined } | undefined> {
  return hidden.get === undefined ? (await hidden.load({ preview: true })).find(row => row.slug === place) : hidden.get(place, { preview: true })
}
