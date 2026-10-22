import type { CheckedHref } from './checks'
import { URL_ATTRIBUTES } from './url-attributes'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// Where the site is mounted when it is not at the root of its host, `/docs` for `https://example.com/docs/`, as `base` in kay.config.ts sets it; read off the page in the browser.
let base: string | undefined

// An origin no site has, to tell a path of this one from what a browser would read as another host: `//host`, `/\host`, or either with a tab or line break inside, which browsers drop.
export const NOWHERE = 'http://nowhere.invalid'

// What a browser drops anywhere in a URL, and the spaces it skips before one.
const URL_STRIPPED = /[\t\n\r]/g
const LEADING_SPACE = /^\s+/
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const CONTROL = /[\0-\x1F\x7F]/
// A `%XX` of the ASCII range, which a lenient decoder turns into its character even beside a malformed escape.
const ASCII_ESCAPE = /%([0-7][\da-f])/gi
// A path whose first segment is empty, or decodes to empty, reads as a host once something decodes or resolves it again: `//evil.example`, `/%2F/evil.example`.
const SECOND_SLASH = /^\/(?:[/\\]|%2f|%5c)/i
const QUERY_OR_HASH = /[?#]/

// The slash ending a path, and the one ending any path but `/`.
export const TRAILING_SLASH = /\/$/
export const NON_ROOT_TRAILING_SLASH = /(?<=.)\/$/
const MOST_LAYERS = 8

// Each URL of a `srcset`, after the start or a comma.
const SRCSET_URL = /(^|,)(\s*)([^\s,]+)/g

function browserBase(): string {
  return base ??= document.querySelector<HTMLMetaElement>('meta[name="kay-base"]')?.content ?? ''
}

// A path of the site under its mount point in the browser: `withBase('/about')` is `/docs/about`, for a link a script builds. On the server it is left as it is, since kay puts what a page renders under the mount point as it goes out.
export function withBase(path: string): string {
  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? path : joinBase(browserBase(), path)
}

// What an island sets in the browser, put under the mount point as the server puts the page it rendered; a path already under it, from `withBase()` or `localize()`, stays as it is.
export function rebasedAttribute(name: string, value: string): string {
  const rebase = (url: string) => withoutBase(url) === url ? withBase(url) : url

  if (name === 'srcset')
    return rebaseSrcset(value, rebase)

  return URL_ATTRIBUTES.includes(name) ? rebase(value) : value
}

export function rebaseSrcset(srcset: string, rebase: (url: string) => string): string {
  return srcset.replace(SRCSET_URL, (_, comma: string, space: string, url: string) => comma + space + rebase(url))
}

// The path the browser is at, its mount point taken off, as the routes know it.
export function withoutBase(path: string): string {
  const mount = typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? '' : browserBase()

  return mount !== '' && (path === mount || path.startsWith(`${mount}/`)) ? path.slice(mount.length) || '/' : path
}

// A path of the site under `mount`, a route that happens to start like it included; another site's URL or a relative one is left as it is.
export function joinBase(mount: string, path: string): string {
  return mount === '' || !path.startsWith('/') || path.startsWith('//') ? path : `${mount}${path}`
}

// `value` when it is a path of this site, as a `?next=` param should be, else `fallback`: `ctx.redirect(localPath(ctx.query.next, '/account'))` never sends anyone to another site. The path comes back as a browser resolves it, with no backslash or control character left.
export function localPath<const Fallback extends string>(value: unknown, fallback: Fallback & CheckedHref<Fallback>): string {
  if (typeof value !== 'string')
    return fallback

  const cleaned = stripped(value)

  if (!cleaned.startsWith('/') || SECOND_SLASH.test(cleaned) || cleaned.includes('\\') || CONTROL.test(cleaned))
    return fallback

  const path = resolved(cleaned)

  if (path === undefined || SECOND_SLASH.test(path))
    return fallback

  // Checked decoded too, for an app or a proxy that decodes before it resolves: `/.%2f/evil.example` is `//evil.example` to it.
  const decoded = decodedPath(path)

  return decoded === undefined || leavesSite(decoded) ? fallback : path
}

// The tab and line break a browser drops only after decoding (`/%09/evil.example`) can leave a second slash or a backslash up front, so each layer of encoding (`/%2509/...`) is decoded leniently, as `unescape` would, until decoding changes nothing; a path still decoding past `MOST_LAYERS` is no real one.
export function leavesSite(decoded: string): boolean {
  let current = decoded

  for (let layer = 0; layer <= MOST_LAYERS; layer++) {
    const cleaned = stripped(current)
    const path = resolved(cleaned)

    if (!cleaned.startsWith('/') || SECOND_SLASH.test(cleaned) || path === undefined || SECOND_SLASH.test(path))
      return true

    const next = cleaned.replace(ASCII_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

    if (next === cleaned)
      return false

    current = next
  }

  return true
}

function stripped(path: string): string {
  return path.replace(URL_STRIPPED, '').replace(LEADING_SPACE, '')
}

// The path as a browser resolves it, dot segments collapsed; undefined when it reads as another host.
function resolved(path: string): string | undefined {
  const url = parsed(path)

  return url?.origin === NOWHERE ? `${url.pathname}${url.search}${url.hash}` : undefined
}

// Undefined for a malformed escape in the path, which nothing could decode either; the query and hash cannot move the path, so a bare `%` there stays as written.
function decodedPath(path: string): string | undefined {
  const end = path.search(QUERY_OR_HASH)
  const split = end === -1 ? path.length : end

  try {
    return decodeURIComponent(path.slice(0, split)) + path.slice(split)
  }
  catch {
    return undefined
  }
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
