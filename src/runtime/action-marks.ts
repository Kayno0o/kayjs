import type { ActionError } from './action-error'

// What the code that posts a call and the code that counts it tell each other: kept apart so the one that posts loads on the first call.

// The reasons of the aborts a `latest` call makes of the earlier ones, which are no failure of a `track()` handle.
export const superseding = new WeakSet<object>()
// The errors of a post that failed in the network, as opposed to one thrown before it was sent (an encoding, a redirect to a page that is none).
export const networkFailures = new WeakSet<object>()
// The action URL each refused call was made to, which `refused` matches.
export const refusedAt = new WeakMap<ActionError, string>()
