// What every store an app plugs in may have, whatever it keeps: `ping` and `close`, both optional and either may return a promise, so a store with neither costs nothing. Callers only await the result, so `close: () => redis.quit()` fits.
// `AppStore` extends it too, so a store keeping every kind (`pgData`) pings and closes them all with one method.
export interface StoreBase {
  // Rejects, or throws, when the store cannot be reached: `health` runs it beside the app's own `check`, under the same `health.timeout`.
  ping?: (() => unknown) | undefined
  // Stops what the store runs in the background and lets go of its file or connection: the server calls it once when it stops, and `await store.close()` does the same for a store opened in a script or a test. Closing twice is the same as once.
  close?: (() => unknown) | undefined
}
