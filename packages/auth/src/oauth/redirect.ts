import { localPath } from 'kay'

// Kept for apps that import it: kay's `localPath`, which guards the same redirects.
export function safeRedirect(path: string | undefined | null, fallback = '/'): string {
  return localPath(path, fallback)
}
