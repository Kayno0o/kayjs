import { IMAGE_ROUTE } from '../runtime/image'

// The resizer's path before 1.92 (kaynooo/kayjs#3018), still answered for pages cached with its links and for links an app wrote, until 1.95.
export const LEGACY_IMAGE_ROUTE = '/_kay/image'

// Whether a path is the resizer, under either name.
export function isImageRoute(path: string): boolean {
  return path === IMAGE_ROUTE || path === LEGACY_IMAGE_ROUTE
}
