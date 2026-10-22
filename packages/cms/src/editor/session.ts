import { ApiError, apiUrl, signal } from 'kay'
import signInApi from '../api/sign-in'

const ended = signal(false)

// Whether a change was refused because the editor's sign-in is over, until one goes through again; the edits stay in the form and in the browser's storage.
export const sessionEnded = () => ended()

export function setSessionEnded(over: boolean): void {
  ended.set(over)
}

// A refusal as the guard answers a request with no sign-in behind it.
export function isSignedOut(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

// The page the editor is on, under the site's mount point as its routes know it; the mount point alone, with a query, is its root.
function pageHere(search = location.search): string {
  const base = document.querySelector<HTMLMetaElement>('meta[name="kay-base"]')?.content ?? ''
  const here = location.pathname

  return (base !== '' && (here === base || here.startsWith(`${base}/`)) ? here.slice(base.length) || '/' : here) + search
}

// The cms's sign-in, which leads back to the page the editor is on. It opens in a new tab, so the edits on this one are not lost.
export function signInHref(): string {
  return apiUrl(signInApi, '/', { query: { redirect: pageHere() } })
}

const TRAILING_SLASHES = /\/+$/

const same = (left: string, right: string) => left.replace(TRAILING_SLASHES, '') === right.replace(TRAILING_SLASHES, '')

function decoded(path: string): string {
  try {
    return decodeURI(path)
  }
  catch {
    return path
  }
}

// Whether the page shown is the one at `url`, whatever its trailing slash and the way its characters are escaped.
export function isShown(url: string): boolean {
  const here = pageHere('')

  return same(here, url) || same(decoded(here), decoded(url))
}
