import { localPath } from 'kay'

/** @deprecated since 1.84: kay's `localPath(path, fallback)`, which this calls; kept until 1.87. */
export function safeRedirect(path: string | undefined | null, fallback = '/'): string {
  return localPath(path, fallback)
}
