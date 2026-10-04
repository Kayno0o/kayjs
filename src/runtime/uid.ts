// Ids unique on the page and the same on the server and once an island hydrates: drawn in render order from a prefix, which the server writes on each island's slot for the browser to count from again.
interface IdScope {
  prefix: string
  next: number
}

let current: IdScope | undefined
// The page the server is rendering: its token keeps ids apart from those of a page swapped out around a persistent island.
let page: { token: string, islands: number } | undefined
// For what renders outside any of these, as a component a test mounts, or one the browser renders afresh.
let fresh = 0

// An id for a label and its control, a trigger and its popup: one per call, unique on the page.
export function uid(): string {
  if (!current)
    return `K${fresh++}`

  return `${current.prefix}${current.next++}`
}

export function withIds<T>(prefix: string, run: () => T): T {
  return countIds(prefix, run).result
}

// Also says how many ids `run` drew, so an island that drew none needs no prefix on its slot.
export function countIds<T>(prefix: string, run: () => T): { result: T, count: number } {
  const previous = current
  const scope = { prefix, next: 0 }

  current = scope

  try {
    return { result: run(), count: scope.next }
  }
  finally {
    current = previous
  }
}

// A page render on the server: its static components draw from the page, each island from a prefix of its own.
export function pageIds<T>(run: () => T): T {
  const previous = page

  page = { token: `k${Math.random().toString(36).slice(2, 8)}`, islands: 0 }

  try {
    return withIds(`${page.token}-`, run)
  }
  finally {
    page = previous
  }
}

// The prefix of the next island the server renders, written on its slot.
export function islandPrefix(): string {
  return page ? `${page.token}-${page.islands++}-` : freshPrefix()
}

// A prefix no server render uses, upper case where the server's are lower: the browser's, for a component it renders afresh.
export function freshPrefix(): string {
  return `K${fresh++}-`
}
