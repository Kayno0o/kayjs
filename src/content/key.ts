// The cache key a page that read the collection carries, which `invalidate` refreshes the page for. Apart from `load` so the check and the editor's server read it without loading the content stack.
export const contentKey = (name: string) => `kay:content:${name}`
