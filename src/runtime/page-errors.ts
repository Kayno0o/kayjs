// What the navigation-only entry's page throws goes to the server's `onError`, as `./client` sends what an island page throws; kept apart so the islands' chunks stay as they were.

// Defined by `kay build --static`, whose host has no server to take the reports. Tested where it is read, not through a constant, so the bundler drops the code sending them.
declare const KAY_STATIC_EXPORT: true | undefined

// Defined by the browser build, which always has a window.
declare const KAY_BROWSER: true | undefined

if (typeof KAY_STATIC_EXPORT === 'undefined' && (typeof KAY_BROWSER !== 'undefined' || typeof window !== 'undefined')) {
  // An error with no error object is another origin's script, whose details the browser hides: nothing to report.
  window.addEventListener('error', (event) => {
    if (event.error !== undefined && event.error !== null)
      void reportLazily(event.error)
  })
  window.addEventListener('unhandledrejection', event => void reportLazily(event.reason))
}

// Loads the code posting errors to the server on the first one, so a page that never fails never ships it.
async function reportLazily(error: unknown, island?: string): Promise<void> {
  try {
    (await import('./report-error')).sendError(error, island)
  }
  // A chunk that fails to load, as after a deploy, loses the report and later ones: the browser keeps it failed.
  catch {}
}
