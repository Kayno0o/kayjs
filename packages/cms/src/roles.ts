// What a role may do beyond editing an entry, which anyone the guard admits can.
export const ACTIONS = ['publish', 'delete', 'upload', 'redirects'] as const

export type Action = typeof ACTIONS[number]

// The roles of `cms({ roles })` as a map, so a role named `__proto__` or `constructor` is a name like any other; undefined when the app gave none.
export function checkRoles(roles: Record<string, readonly Action[]> | undefined, guarded: boolean): ReadonlyMap<string, ReadonlySet<Action>> | undefined {
  if (roles === undefined)
    return undefined

  if (!guarded)
    throw new Error('kayjs-cms: `cms({ roles })` needs a `guard`, which says who the signed-in person is')

  const checked = new Map<string, ReadonlySet<Action>>()

  for (const [role, actions] of Object.entries(roles)) {
    if (!Array.isArray(actions))
      throw new TypeError(`kayjs-cms: \`cms({ roles })\` gives ${JSON.stringify(role)} ${JSON.stringify(actions)}; it takes a list of ${ACTIONS.map(action => `'${action}'`).join(', ')}`)

    const unknown = (actions as readonly unknown[]).find(action => !ACTIONS.includes(action as Action))

    if (unknown !== undefined)
      throw new Error(`kayjs-cms: \`cms({ roles })\` gives ${JSON.stringify(role)} the action ${JSON.stringify(unknown)}; the actions are ${ACTIONS.join(', ')}`)

    checked.set(role, new Set(actions))
  }

  return checked
}
