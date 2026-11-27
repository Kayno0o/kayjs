// What `kay dev` and its app process share, kept apart so the parent never loads the build to read it.

export type RecycleReason = 'config' | 'memory'

/** The header the parent sets to the browser's address on each request it passes to the app process. */
export const DEV_CLIENT_IP_HEADER = 'x-kay-dev-client-ip'

/** The environment variable holding the app process's {@link DevChildOptions}, as JSON. */
export const DEV_CHILD_ENV = 'KAY_DEV_CHILD'

export interface DevChildOptions {
  root: string
  routesDir?: string | undefined
  unix: string
  maxRssMb?: number | undefined
}

export type DevChildMessage =
  | { t: 'ready', assetPrefix: string }
  | { t: 'event', payload: string }
  | { t: 'recycle', reason: RecycleReason }
