import type { EditSite } from './edit'
import type { Collection } from './index'
import { folderOf, indexes } from './edit-entries'

let registered: [string, Collection<unknown>][] = []
let site: EditSite | undefined

// The collections the content config exports, by name, as the server read them when it started; gives back those registered before, for a test to put back.
export function registerCollections(named: [string, Collection<unknown>][]): [string, Collection<unknown>][] {
  const previous = registered

  registered = named
  indexes.clear()

  return previous
}

// The folders the registered collections read their entries from, resolved against the content config's, or none when one of them has a loader, whose entries the process keeps after the config runs again.
export function reloadableFolders(): string[] | undefined {
  if (registered.some(([, collection]) => collection.dir === undefined))
    return undefined

  return registered.map(([, collection]) => folderOf(collection.dir!))
}

// Gives back what was registered before, for a test to put back.
export function registerEditSite(served: EditSite | undefined): EditSite | undefined {
  const previous = site

  site = served

  return previous
}

// A server stopping forgets its site, unless another one registered since.
export function clearEditSite(served: EditSite): void {
  if (site === served)
    site = undefined
}

export function registeredCollections(): [string, Collection<unknown>][] {
  return registered
}

export function editSite(): EditSite | undefined {
  return site
}
