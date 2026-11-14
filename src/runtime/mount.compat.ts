import type { Mounted as MountedIn } from './mount'
import { mount as mountIn } from './mount'

/** @deprecated Import `Mounted` from `kay`, its one home. Removed in 1.108.0; `deprecated-import-path` rewrites it. */
export type Mounted<P extends object> = MountedIn<P>

/** @deprecated Import `mount` from `kay`, its one home. Removed in 1.108.0; `deprecated-import-path` rewrites it. */
export const mount: typeof mountIn = mountIn
