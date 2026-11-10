// What a start does with a route no guard covers: `true` refuses every page, layout with actions, endpoint and API module of the app, `'routes'` only its pages, endpoints and API modules, `false` none.
export type GuardRequirement = boolean | 'routes'

interface Access {
  open?: true | undefined
  guards: readonly unknown[]
}

// What `requireGuards` comes to once the routes are scanned: a setting is taken as it is, and an unset one refuses the routes no guard covers on a site that guards some of its own, which a site with no guard at all (a brochure) leaves open.
// Guards a library mounts on its own routes say nothing of the app's: those routes are `open`, and only the app's own guarded routes mark a site that has started to guard.
export function guardRequirement(configured: boolean | undefined, ...routes: Iterable<Access>[]): GuardRequirement {
  if (configured !== undefined)
    return configured

  return routes.some(list => [...list].some(route => route.open !== true && route.guards.length > 0)) ? 'routes' : false
}
