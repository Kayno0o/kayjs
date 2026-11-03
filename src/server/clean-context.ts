import { AsyncLocalStorage } from 'node:async_hooks'

// A snapshot only holds what was active where it was taken, so this module must first load at the server's start, as its importers (the queue scheduler, the rooms and presence stores) are loaded with it; first imported from inside a request it would carry that request (`tests/run-hooks.test.ts` holds the assumption).
// Runs a function in the async context this module was loaded in, inside no request.
// Work started by whichever request came first, a queue's workers, a room's heartbeat, a list's sweeper, must not keep that request, its scope, locale, preview or reads for the process's life.
export const outsideRequest = AsyncLocalStorage.snapshot()
