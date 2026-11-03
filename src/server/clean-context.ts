import { AsyncLocalStorage } from 'node:async_hooks'

// Runs a function in the async context this module was loaded in, at the server's start and so inside no request.
// A queue's workers start inside whichever request first woke a lazy queue, and must not keep that request's scope, locale, preview or reads for every job after.
export const outsideRequest = AsyncLocalStorage.snapshot()
