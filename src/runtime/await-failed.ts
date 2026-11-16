import type { AwaitProps } from './checks'

// What an `await` block with no `catch` and no `try` around it shows once its value rejects, under the key the app's catalogs may word.
export const AWAIT_FAILED_KEY = 'kay.await.failed'
export const AWAIT_FAILED = 'This could not be loaded; try again later'

// The props a compiled `await` is given: `AwaitProps`, plus the `catch` of the `try` around it, which the compiler passes and a template never writes.
// `alert` is the app's `await-failed.kay` drawn in place of kay's alert, which the compiler passes to an `await` with no `catch` and no `try` around it.
export type AwaitChannel<T> = AwaitProps<T> & { fallback?: ((error: unknown) => unknown) | undefined, alert?: ((error: unknown, retry?: () => void) => unknown) | undefined }
