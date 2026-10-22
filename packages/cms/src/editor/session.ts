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

// The cms's sign-in, which leads back to the page the editor is on. It opens in a new tab, so the edits on this one are not lost.
export function signInHref(): string {
  const base = document.querySelector<HTMLMetaElement>('meta[name="kay-base"]')?.content ?? ''
  const here = location.pathname + location.search
  const path = base !== '' && (here === base || here.startsWith(`${base}/`)) ? here.slice(base.length) || '/' : here

  return apiUrl(signInApi, '/', { query: { redirect: path } })
}
