import type { CollectionInfo, DraftEntry, DraftResult, EntryFile, SourceEntry } from './contract'

// Server half of kaynooo/kayjs#262, to come from `kay/content`: until kay ships it, each call says so rather than pretending.
function pending(name: string): never {
  throw new Error(`kay does not ship ${name}() yet (kaynooo/kayjs#262)`)
}

export async function collections(): Promise<CollectionInfo[]> {
  return pending('collections')
}

export async function entries(_collection: string, _options?: { locale?: string }): Promise<SourceEntry[]> {
  return pending('entries')
}

export async function entrySource(_collection: string, _entry: Omit<DraftEntry, 'collection'>): Promise<EntryFile> {
  return pending('entrySource')
}

export async function saveEntry(_collection: string, _entry: Omit<DraftEntry, 'collection'>): Promise<DraftResult> {
  return pending('saveEntry')
}
