// The id a page's cached values read with `live: true` go by: one keyed live value, whose value for a cache key is the time it was last invalidated, in milliseconds, 0 for a key never invalidated.
export const CACHE_LIVE_ID = 'kay:cache'

// Set once the code following cached keys is loaded, which an action's call looks at before it loads it for nothing.
export const liveCache = { loaded: false }
