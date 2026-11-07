import { configError } from 'kay/library'

// What a role may do beyond editing an entry, which anyone the guard admits can.
export const ACTIONS = ['publish', 'review', 'delete', 'upload', 'redirects'] as const

export type CmsAction = typeof ACTIONS[number]

// A role limited to some collections and to the entries its holder wrote: `{ collections: ['posts'], own: 'author', actions: ['publish'] }`.
export interface RoleScope {
  // The actions the role may do beyond editing, within its scope.
  actions?: readonly CmsAction[] | undefined
  // The collections the role reaches, by name: it lists, reads and edits those and no others. Every collection when left out.
  collections?: readonly string[] | undefined
  // The field of an entry that names its writer, so the role changes only the entries whose field holds the signed-in person's id, else email, else name. The entries of the others stay readable. A new entry is written with the field set to the person, and a save never changes it.
  own?: string | undefined
}

// What `cms({ roles })` gives a role: the actions it may do in every collection, or the same limited by a scope.
export type GivenRole = readonly CmsAction[] | RoleScope

// A role as the guard reads it.
export interface Role {
  actions: ReadonlySet<CmsAction>
  // Undefined for every collection.
  collections: ReadonlySet<string> | undefined
  // The field naming the writer, undefined for every entry of the collections.
  own: string | undefined
}

const SCOPE_KEYS = ['actions', 'collections', 'own']

function checkActions(role: string, actions: unknown): readonly CmsAction[] {
  if (!Array.isArray(actions))
    throw configError('cms', 'roles', `\`cms({ roles })\` gives ${JSON.stringify(role)} ${JSON.stringify(actions)}; it takes a list of ${ACTIONS.map(action => `'${action}'`).join(', ')}`)

  const unknown = (actions as readonly unknown[]).find(action => !ACTIONS.includes(action as CmsAction))

  if (unknown !== undefined)
    throw configError('cms', 'roles', `\`cms({ roles })\` gives ${JSON.stringify(role)} the action ${JSON.stringify(unknown)}; the actions are ${ACTIONS.join(', ')}`)

  return actions as readonly CmsAction[]
}

function isScope(given: unknown): given is RoleScope {
  return typeof given === 'object' && given !== null && !Array.isArray(given)
}

function checkScope(role: string, scope: RoleScope): Role {
  const unknown = Object.keys(scope).find(key => !SCOPE_KEYS.includes(key))

  if (unknown !== undefined)
    throw configError('cms', 'roles', `\`cms({ roles })\` gives ${JSON.stringify(role)} the key ${JSON.stringify(unknown)}; a role takes ${SCOPE_KEYS.join(', ')}`)

  const { collections, own } = scope

  if (collections !== undefined && (!Array.isArray(collections) || collections.length === 0 || collections.some(name => typeof name !== 'string' || name === '')))
    throw configError('cms', 'roles', `\`cms({ roles })\` gives ${JSON.stringify(role)} the collections ${JSON.stringify(collections)}; it takes a list of collection names`)

  if (own !== undefined && (typeof own !== 'string' || own === ''))
    throw configError('cms', 'roles', `\`cms({ roles })\` gives ${JSON.stringify(role)} the own field ${JSON.stringify(own)}; it takes the name of the entry field that holds the writer`)

  return { actions: new Set(scope.actions === undefined ? [] : checkActions(role, scope.actions)), collections: collections && new Set(collections), own }
}

// The roles of `cms({ roles })` as a map, so a role named `__proto__` or `constructor` is a name like any other; undefined when the app gave none.
export function checkRoles(roles: Record<string, GivenRole> | undefined, guarded: boolean): ReadonlyMap<string, Role> | undefined {
  if (roles === undefined)
    return undefined

  if (!guarded)
    throw configError('cms', 'roles', '`cms({ roles })` needs a `guard`, which says who the signed-in person is')

  const checked = new Map<string, Role>()

  for (const [role, given] of Object.entries(roles))
    checked.set(role, isScope(given) ? checkScope(role, given) : { actions: new Set(checkActions(role, given)), collections: undefined, own: undefined })

  return checked
}
