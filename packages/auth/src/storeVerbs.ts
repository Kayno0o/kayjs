import type { AuthStore, LegacyAuthStore } from './store'
import { log } from './log'

// Each message once per process, so a store still on an old verb does not log a line per call.
const warned = new Set<string>()

function warnOnce(message: string) {
  if (warned.has(message))
    return

  warned.add(message)
  log.warn(message)
}

type Verb = (...args: never[]) => unknown

// A view of `target` whose own methods still run on `target`, so a store written as a class keeps its private fields and state, with `overrides` answering instead of what `target` has under those names. The proxy wraps an empty object rather than `target`, as a frozen or sealed `target` would make the proxy's invariants refuse the overrides; each method is bound once, so reading it twice gives the same function.
function view<T extends object>(target: T, overrides: Record<string, unknown>): T {
  const bound = new WeakMap<Verb, Verb>()

  const read = (key: string | symbol): unknown => {
    if (typeof key === 'string' && Object.hasOwn(overrides, key))
      return overrides[key]

    const value: unknown = Reflect.get(target, key, target)

    if (typeof value !== 'function')
      return value

    const method = value as Verb
    let result = bound.get(method)

    if (!result) {
      result = method.bind(target)
      bound.set(method, result)
    }

    return result
  }

  return new Proxy({} as T, {
    get: (_, key) => read(key),
    has: (_, key) => (typeof key === 'string' && Object.hasOwn(overrides, key)) || key in target,
    ownKeys: () => [...new Set([...Reflect.ownKeys(target), ...Object.keys(overrides)])],
    getOwnPropertyDescriptor: (_, key) => {
      const own = (typeof key === 'string' && Object.hasOwn(overrides, key)) || Object.hasOwn(target, key)

      return own ? { value: read(key), writable: true, enumerable: typeof key !== 'string' || Object.hasOwn(overrides, key) || Object.getOwnPropertyDescriptor(target, key)?.enumerable === true, configurable: true } : undefined
    },
  })
}

// The store with the verbs of 1.52: `members.delete` and `oauth.grants.upsert`, which 1.51 named `members.remove` and `oauth.grants.put`. A store that has only the old name keeps working, through a view that leaves the app's object alone; one that has both is used as it is.
export function acceptOldVerbs(store: AuthStore | LegacyAuthStore): AuthStore {
  const members = store.members as { delete?: unknown, remove?: Verb } | undefined
  const grants = store.oauth?.grants as { upsert?: unknown, put?: Verb } | undefined
  const oldMembers = members !== undefined && members.delete === undefined && typeof members.remove === 'function'
  const oldGrants = grants !== undefined && grants.upsert === undefined && typeof grants.put === 'function'

  if (!oldMembers && !oldGrants)
    return store as AuthStore

  const overrides: Record<string, unknown> = {}

  if (oldMembers) {
    warnOnce('store.members.remove is renamed store.members.delete')
    overrides.members = view(members, { delete: members.remove!.bind(members) })
  }

  if (oldGrants) {
    warnOnce('store.oauth.grants.put is renamed store.oauth.grants.upsert')
    overrides.oauth = view(store.oauth!, { grants: view(grants, { upsert: grants.put!.bind(grants) }) })
  }

  return view(store, overrides) as AuthStore
}

// For a test: the next old verb warns again.
export function forgetWarnings() {
  warned.clear()
}
