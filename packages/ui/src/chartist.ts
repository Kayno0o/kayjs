interface Loaders {
  live: () => Promise<typeof import('chartist/live')>
  compat: () => Promise<typeof import('chartist/compat')>
}

const real: Loaders = {
  live: async () => import('chartist/live'),
  compat: loadCompat,
}

// How LineChart reaches the parts of chartist it loads on demand, in one object so a test can replace what a load does. `mountComponent` bundles the component into a copy of this module of its own, which a test cannot import, so under a test run (kay/test's preload sets `KAY_TEST_PARENT`) a load goes through what a test planted on the global object under this key, and a page never reads it.
const LOADERS_KEY = Symbol.for('kayjs-ui.chartist-loaders')

const planted = (): Partial<Loaders> => (globalThis as { [LOADERS_KEY]?: Partial<Loaders> })[LOADERS_KEY] ?? {}

export const loaders: Loaders = typeof process !== 'undefined' && process.env.KAY_TEST_PARENT !== undefined
  ? { live: async () => (planted().live ?? real.live)(), compat: async () => (planted().compat ?? real.compat)() }
  : real

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
