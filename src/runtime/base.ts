// Where the site is mounted when it is not at the root of its host, `/docs` for `https://example.com/docs/`, as `base` in kay.config.ts sets it; read off the page in the browser.
let base: string | undefined

const BASE_META = 'meta[name="kay-base"]'

function browserBase(): string {
  return base ??= document.querySelector<HTMLMetaElement>(BASE_META)?.content ?? ''
}

// A path of the site under its mount point in the browser: `withBase('/about')` is `/docs/about`, for a link a script builds. On the server it is left as it is, since kay puts what a page renders under the mount point as it goes out.
export function withBase(path: string): string {
  return typeof document === 'undefined' ? path : joinBase(browserBase(), path)
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
