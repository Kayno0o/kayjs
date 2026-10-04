// Where the site is mounted when it is not at the root of its host, `/docs` for `https://example.com/docs/`: set from `base` in kay.config.ts on the server, read off the page in the browser.
let base: string | undefined

const BASE_META = 'meta[name="kay-base"]'

export function setBase(value: string): void {
  base = value
}

function currentBase(): string {
  return base ??= typeof document === 'undefined' ? '' : document.querySelector<HTMLMetaElement>(BASE_META)?.content ?? ''
}

// A path of the site under its mount point: `withBase('/about')` is `/docs/about`. kay adds it to the links and assets a page renders on the server; what a script builds in the browser takes it from here.
export function withBase(path: string): string {
  return joinBase(currentBase(), path)
}

// A path the browser is at, its mount point taken off, as the routes know it.
export function withoutBase(path: string): string {
  const mount = currentBase()

  return mount !== '' && (path === mount || path.startsWith(`${mount}/`)) ? path.slice(mount.length) || '/' : path
}

// A path of the site under `mount`; another site's URL, a relative one or one already under it is left as it is.
export function joinBase(mount: string, path: string): string {
  return mount === '' || !path.startsWith('/') || path.startsWith('//') || path === mount || path.startsWith(`${mount}/`) ? path : `${mount}${path}`
}
