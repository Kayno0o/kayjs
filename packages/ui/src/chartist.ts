// The one load of chartist/compat, which sets up the global `Chartist` for the plugin scripts of the 0.x and 1.x era when it is imported: kayjs-ui sets none, so the app's own global is hidden while the module evaluates and put back after.
let compatLoad: Promise<typeof import('chartist/compat')> | undefined

export async function loadCompat(): Promise<typeof import('chartist/compat')> {
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
