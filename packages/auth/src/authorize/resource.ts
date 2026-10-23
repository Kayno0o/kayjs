import type { Core } from '../core'
import { configuredSite } from 'kay/library'

const TRAILING_SLASHES = /\/+$/

// A path as the router reads it, whether or not the proxy took the mount point `base` off.
function withoutBase(path: string, base: string): string {
  return base !== '' && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || '/' : path
}

// The mount point of the app: the path of the `site` kay.config.ts sets, else the one of `createAuth`, '' at the root.
export function siteBase(core: Core): string {
  const fixed = configuredSite()?.origin ?? core.url

  try {
    return fixed === undefined ? '' : new URL(fixed).pathname.replace(TRAILING_SLASHES, '')
  }
  catch {
    return ''
  }
}

// Whether the request `url` is the resource or under its path (RFC 8707 audience), the query ignored, a trailing slash either way and the mount point `base` on both sides or neither.
export function underResource(resource: string, url: string, base = ''): boolean {
  try {
    const bound = withoutBase(new URL(resource).pathname, base).replace(TRAILING_SLASHES, '')
    const path = withoutBase(new URL(url).pathname, base)

    return path === bound || path.startsWith(`${bound}/`)
  }
  catch {
    return false
  }
}
