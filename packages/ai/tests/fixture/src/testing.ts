import type { Provider } from '@kaynooo/kayjs-ai'

// What the tests reach from the fixture's actions: the provider they ask, and what the tools did.
export const testing: { provider: Provider | undefined } = { provider: undefined }
export const done: string[] = []
// What the app's own reader of the `staying` action's reply ended with, one entry per reply.
export const heard: string[] = []
// Called as the `slow` tool starts, for a test waiting on it instead of a guess at its timing.
export const hooks: { slowStarted?: (() => void) | undefined } = {}

// The statuses the `refusing` action answers its next calls with, then it answers like `reply`.
export const refusals: number[] = []
