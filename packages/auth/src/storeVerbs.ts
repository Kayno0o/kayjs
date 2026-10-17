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

// Another object over `target` with `name` added, so a store written as a class keeps its methods and `this`.
function withVerb<T extends object>(target: T, name: string, verb: (...args: never[]) => unknown): T {
  return Object.create(target, { [name]: { value: verb.bind(target), enumerable: true, writable: true, configurable: true } }) as T
}

// The store with the verbs of 1.52: `members.delete` and `oauth.grants.upsert`, which 1.51 named `members.remove` and `oauth.grants.put`. A store that has only the old name keeps working, through a copy that leaves the app's object alone; one that has both is used as it is.
export function acceptOldVerbs(store: AuthStore | LegacyAuthStore): AuthStore {
  const members = store.members as { delete?: unknown, remove?: (...args: never[]) => unknown } | undefined
  const grants = store.oauth?.grants as { upsert?: unknown, put?: (...args: never[]) => unknown } | undefined
  const oldMembers = members !== undefined && members.delete === undefined && typeof members.remove === 'function'
  const oldGrants = grants !== undefined && grants.upsert === undefined && typeof grants.put === 'function'

  if (!oldMembers && !oldGrants)
    return store as AuthStore

  const additions: PropertyDescriptorMap = {}

  if (oldMembers) {
    warnOnce('store.members.remove is renamed store.members.delete')
    additions.members = { value: withVerb(members, 'delete', members.remove!), enumerable: true }
  }

  if (oldGrants) {
    warnOnce('store.oauth.grants.put is renamed store.oauth.grants.upsert')
    additions.oauth = { value: Object.create(store.oauth!, { grants: { value: withVerb(grants, 'upsert', grants.put!), enumerable: true } }) as object, enumerable: true }
  }

  return Object.create(store, additions) as AuthStore
}
