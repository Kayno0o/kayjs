import type { Resource } from './live'

// The server's half of `resource()`: a page renders in one synchronous pass, so a route an island reads is asked for in a first pass that is thrown away, and the pass that follows renders the islands `ready` with what the routes answered.

// What a route answered in process: the value as the browser's fetch would read it, and the proof its live keys came with.
export interface Seed {
  value: unknown
  proof: string | null
}

interface Collecting {
  // What the routes answered so far, by key; null for a route that refused or failed, which stays `loading` for the browser to ask.
  seeds: Map<string, Seed | null>
  // The routes the pass being rendered asked for and nothing answered yet, key to URL.
  wanted: Map<string, string>
  // The seeds the pass read, which the page hands the browser.
  used: Map<string, Seed>
  last: boolean
}

let collecting: Collecting | undefined

// Runs one synchronous render that notes the routes its islands read.
// The last pass asks for nothing more: what is still unanswered renders `loading`.
export function collectResources<T>(seeds: Map<string, Seed | null>, render: () => T, last: boolean): T {
  const pass: Collecting = { seeds, wanted: new Map(), used: new Map(), last }
  const previous = collecting

  collecting = pass

  try {
    return render()
  }
  finally {
    collecting = previous
  }
}

// The routes the render in progress left unanswered, for the page to ask and render again.
export function resourcesWanted(): ReadonlyMap<string, string> | undefined {
  return collecting !== undefined && collecting.wanted.size > 0 ? collecting.wanted : undefined
}

// The seeds the render in progress handed its islands, for the page to write out.
export function resourcesUsed(): ReadonlyMap<string, Seed> | undefined {
  return collecting?.used
}

function seedFor(key: string, url: string): Seed | undefined {
  if (collecting === undefined)
    return undefined

  const seed = collecting.seeds.get(key)

  if (seed === undefined) {
    if (!collecting.last && !collecting.wanted.has(key))
      collecting.wanted.set(key, url)

    return undefined
  }

  if (seed !== null)
    collecting.used.set(key, seed)

  return seed ?? undefined
}

// What `resource()` is on the server: `ready` with `initial` or with what the route answered in process, else `loading` as the browser takes over.
// `url` is undefined for a resource that is no route, which nothing asks for here.
export function serverResource<T>(key: string | undefined, url: string | undefined, initial: { value: unknown } | undefined): Resource<T> {
  const seed = initial === undefined && key !== undefined && url !== undefined ? seedFor(key, url) : undefined
  const known = initial ?? seed
  const value = known?.value as T | undefined
  const ready = known !== undefined

  return {
    value: () => value,
    status: () => ready ? 'ready' : 'loading',
    pending: () => !ready,
    error: () => undefined,
    refresh: () => undefined,
    retry: () => undefined,
    mutate: () => undefined,
  }
}
