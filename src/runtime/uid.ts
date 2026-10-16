// Ids unique on the page and the same on the server and once an island hydrates: drawn in render order from a prefix, which the server writes on each island's slot for the browser to count from again.
interface IdScope {
  prefix: string
  next: number
  // `try` blocks that failed, each of whose fallback draws from a prefix of its own.
  failed: number
}

let current: IdScope | undefined
// The page the server is rendering: its token keeps ids apart from those of a page swapped out around a persistent island.
let page: { token: string, islands: number } | undefined
// A token to use in place of a random one, for two renders of a page to be compared.
let fixedToken: string | undefined
// For what renders outside any of these, as a component a test mounts, or one the browser renders afresh.
let unscoped = 0

// An id for a label and its control, a trigger and its popup: one per call, unique on the page.
export function uid(): string {
  return !current ? `K${unscoped++}` : `${current.prefix}${current.next++}`
}

export function withIds<T>(prefix: string, run: () => T): T {
  return countIds(prefix, run).result
}

// Also says how many ids `run` drew, so an island that drew none needs no prefix on its slot.
export function countIds<T>(prefix: string, run: () => T): { result: T, count: number } {
  const previous = current
  const scope = { prefix, next: 0, failed: 0 }

  current = scope

  try {
    return { result: run(), count: scope.next }
  }
  finally {
    current = previous
  }
}

// Where the ids of a `try` block start, to give them back if it fails.
export function idMark(): number | undefined {
  return current?.next
}

// The fallback of a `try` block that failed on the server: the browser keeps the server's markup there and draws none of its ids, so the block's are given back and the fallback draws from a prefix no other id has.
export function failedIds<T>(mark: number | undefined, run: () => T): T {
  if (!current || mark === undefined)
    return run()

  current.next = mark

  return withIds(`${current.prefix}e${current.failed++}-`, run)
}

// Renders with the page's ids drawn from `token`, so two renders of a page that reads nothing can be compared byte for byte.
export async function withPageToken<T>(token: string, run: () => Promise<T>): Promise<T> {
  const previous = fixedToken

  fixedToken = token

  try {
    return await run()
  }
  finally {
    fixedToken = previous
  }
}

// A page render on the server: its static components draw from the page, each island from a prefix of its own.
export function pageIds<T>(run: () => T): T {
  const previous = page

  page = { token: fixedToken ?? `k${Math.random().toString(36).slice(2, 8)}`, islands: 0 }

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
  return `K${unscoped++}-`
}
