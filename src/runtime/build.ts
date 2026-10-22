import { noticed, reloadIfStale } from './stale'

// Defined by `kay build --static`, whose host sends no build header for an answer to name.
declare const KAY_STATIC_EXPORT: true | undefined

// Defined by the browser build, which never renders on the server.
declare const KAY_BROWSER: true | undefined

// What a page of a build the server replaced does about it: given the response that showed it, whether the page is reloading; given none, whether a chunk it failed to load was dropped by a deploy, which reloads it.
// It lives in the entry because a chunk loaded later would be gone with the rest once a deploy dropped them.
export async function skew(response?: Response): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production' || (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined'))
    return false

  try {
    return await (response ? typeof KAY_STATIC_EXPORT === 'undefined' && noticed(response) : reloadIfStale())
  }
  catch {
    return false
  }
}
