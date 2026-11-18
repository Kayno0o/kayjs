import type { Lint } from './lints'

// The lints of the `deprecated` group for how an island read its sources and actions before 1.105, with the others in `DEPRECATED_LINTS`.
export const SOURCE_READERS = {,
} as const satisfies Record<string, Lint>
