// The resources naming tags, a key an action invalidates: each asks its route again when a call of this page invalidated one.
const watchers = new Set<{ tags: readonly string[], refetch: () => void }>()

// Registers a resource's tags until the returned function runs.
export function watchTags(tags: readonly string[], refetch: () => void): () => void {
  const watcher = { tags, refetch }

  watchers.add(watcher)

  return () => void watchers.delete(watcher)
}

// Asks again every resource naming one of `keys`, and gives back the keys none of them names.
export function refetchTagged(keys: readonly string[]): string[] {
  const named = new Set<string>()

  for (const watcher of watchers) {
    const hit = watcher.tags.filter(tag => keys.includes(tag))

    if (hit.length === 0)
      continue

    for (const tag of hit)
      named.add(tag)

    watcher.refetch()
  }

  return keys.filter(key => !named.has(key))
}
