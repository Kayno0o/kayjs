interface Loaders {
  live: () => Promise<typeof import('chartist/live')>
  compat: () => Promise<typeof import('chartist/compat')>
}

// How LineChart reaches the parts of chartist it loads on demand. A dom test replaces what a load does with `mock.module('chartist/live', ...)`, which `mountComponent` lets reach this module's imports.
export const loaders: Loaders = {
  live: async () => import('chartist/live'),
  compat: loadCompat,
}

let compatLoad: Promise<typeof import('chartist/compat')> | undefined

// chartist/compat sets up the global `Chartist` for the plugin scripts of the 0.x and 1.x era when it is imported: kayjs-ui sets none, so the app's own global is hidden while the module evaluates and put back after.
async function loadCompat(): Promise<typeof import('chartist/compat')> {
  compatLoad ??= (async () => {
    const root = globalThis as { Chartist?: unknown }
    const owned = Object.hasOwn(root, 'Chartist')
    const theirs = root.Chartist

    delete root.Chartist

    try {
      return await import('chartist/compat')
    }
    catch (error) {
      compatLoad = undefined

      throw error
    }
    finally {
      if (owned)
        root.Chartist = theirs
      else
        delete root.Chartist
    }
  })()

  return compatLoad
}
