// What the page swap shares with action calls and the server, apart from it so that neither bundles the swap.

// Where a called action, or a form the swap posts, sends the browser, in place of `location`, which fetch and XMLHttpRequest would follow.
export const REDIRECT_HEADER = 'x-kay-redirect'
// Marks a request of the swap: a page it fetches, or a form it posts, which then reads where to go from `REDIRECT_HEADER` as a call does.
export const NAVIGATE_HEADER = 'x-kay-navigate'
// Marks a failure: a called action's body as the encoded `{ errors, data }`, which a denial or an error answered as text is not, or the page a refused form post renders in answer.
export const FAILURE_HEADER = 'x-kay-failure'
// Names the page an action is called, or a form posted, from, which its params, its locale and where a form post goes back to are read off: a `Referer` the app's `referrer-policy` may cut.
export const PAGE_HEADER = 'x-kay-page'

export interface FetchedPage {
  url: string
  type: string
  html: string
}

// Whether the swap took over the app's links, which an action call then shows its effects through, and how many other pages it showed since, which a call's outcome belongs to one of.
export const swapState = { started: false, page: 0 }

// Pages fetched ahead of a click, by URL; an action may change what they show, so each post forgets them.
export const prefetched = new Map<string, { at: number, page: Promise<FetchedPage> }>()
