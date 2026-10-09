export const ISLAND_TWIN = '?island'

// The `.kay` file a module path names, its `?island` twin included.
export function withoutTwin(path: string): string {
  return path.endsWith(ISLAND_TWIN) ? path.slice(0, -ISLAND_TWIN.length) : path
}
