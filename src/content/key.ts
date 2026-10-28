// The cache key a page that read the collection carries, which `invalidate` refreshes the page for. Apart from `load` so the check and the editor's server read it without loading the content stack.
// kept: free
export const contentKey = (name: string) => `kay:content:${name}`

// What a loader's `saveMany` throws when an entry it was asked to change by `expect` is gone or holds another value there, having written nothing: `saveEntries` answers `{ changed: true }` for it.
// kept: free
export class ContentChangedError extends Error {
  override name = 'ContentChangedError'
}
