import type { CheckedHref } from './checks'
import { URL_ATTRIBUTES } from './url-attributes'

// Where the site is mounted when it is not at the root of its host, `/docs` for `https://example.com/docs/`, as `base` in kay.config.ts sets it; read off the page in the browser.
let base: string | undefined

// An origin no site has, to tell a path of this one from what a browser would read as another host: `//host`, `/\host`, or either with a tab or line break inside, which browsers drop.
export const NOWHERE = 'http://nowhere.invalid'

// Each URL of a `srcset`, after the start or a comma.
const SRCSET_URL = /(^|,)(\s*)([^\s,]+)/g

function browserBase(): string {
  return base ??= document.querySelector<HTMLMetaElement>('meta[name="kay-base"]')?.content ?? ''
}

// A path of the site under its mount point in the browser: `withBase('/about')` is `/docs/about`, for a link a script builds. On the server it is left as it is, since kay puts what a page renders under the mount point as it goes out.
export function withBase(path: string): string {
  return typeof document === 'undefined' ? path : joinBase(browserBase(), path)
}

// What an island sets in the browser, put under the mount point as the server puts the page it rendered; a path already under it, from `withBase()` or `localize()`, stays as it is.
export function rebasedAttribute(name: string, value: string): string {
  const rebase = (url: string) => withoutBase(url) === url ? withBase(url) : url

  return name === 'srcset' ? rebaseSrcset(value, rebase) : URL_ATTRIBUTES.includes(name) ? rebase(value) : value
}

export function rebaseSrcset(srcset: string, rebase: (url: string) => string): string {
  return srcset.replace(SRCSET_URL, (_, comma: string, space: string, url: string) => comma + space + rebase(url))
}

// The path the browser is at, its mount point taken off, as the routes know it.
export function withoutBase(path: string): string {
  const mount = typeof document === 'undefined' ? '' : browserBase()

  return mount !== '' && (path === mount || path.startsWith(`${mount}/`)) ? path.slice(mount.length) || '/' : path
}

// A path of the site under `mount`, a route that happens to start like it included; another site's URL or a relative one is left as it is.
export function joinBase(mount: string, path: string): string {
  return mount === '' || !path.startsWith('/') || path.startsWith('//') ? path : `${mount}${path}`
}

// `value` when it is a path of this site, as a `?next=` param should be, else `fallback`: `ctx.redirect(localPath(ctx.query.next, '/account'))` never sends anyone to another site. The path comes back as a browser reads it, with no backslash or control character left.
export function localPath<const Fallback extends string>(value: unknown, fallback: Fallback & CheckedHref<Fallback>): string {
  const url = typeof value === 'string' && value.startsWith('/') ? parsed(value) : undefined

  if (!url)
    return fallback

  // A dot segment can leave the path starting `//`, `/.//evil.example` for one, which a browser reads as a host.
  return url.origin === NOWHERE && !url.pathname.startsWith('//') ? `${url.pathname}${url.search}${url.hash}` : fallback
}

// Not `URL.canParse`, which Safari before 17 lacks.
function parsed(path: string): URL | undefined {
  try {
    return new URL(path, NOWHERE)
  }
  catch {
    return undefined
  }
}
