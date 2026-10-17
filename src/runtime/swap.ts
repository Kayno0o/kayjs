// The headers and markers the page swap and action calls share with the server, apart from them so that the server bundles neither.

// Where a called action, or a form the swap posts, sends the browser, in place of `location`, which fetch and XMLHttpRequest would follow.
export const REDIRECT_HEADER = 'x-kay-redirect'
// Marks a request of the swap: a page it fetches, or a form it posts, which then reads where to go from `REDIRECT_HEADER` as a call does.
export const NAVIGATE_HEADER = 'x-kay-navigate'
// Marks a failure: a called action's body as the encoded `{ errors, data }`, which a denial or an error answered as text is not, or the page a refused form post renders in answer.
export const FAILURE_HEADER = 'x-kay-failure'
// Names the page an action is called, or a form posted, from, which its params, its locale and where a form post goes back to are read off: a `Referer` the app's `referrer-policy` may cut.
export const PAGE_HEADER = 'x-kay-page'
// Carries the solution to an action's `proofOfWork` challenge, and the fresh challenge a post refused for lacking one gets back.
export const WORK_HEADER = 'x-kay-work'
// Marks a page loaded fully from any link or form, past the swap: one setting `reload: true`.
export const RELOAD_HEADER = 'x-kay-reload'
// Names the build a response comes from, on every one a production server answers: the hash in the file name of the entry chunk its pages load, which changes with any island's code.
export const BUILD_HEADER = 'x-kay-build'
// Where edit mode's `showDraft` posts the entries an editor has not saved, for the page rendered with them.
export const DRAFT_ROUTE = '/_kay/draft'
// Marks the data script holding the challenges of the actions a page's forms post to, by action URL.
export const WORK_SCRIPT = 'data-kay-work'

const ENTRY_HASH = /-([\da-z]+)\.js$/
const QUERY_OR_HASH = /[?#]/

// The build an entry chunk's URL belongs to: the hash Bun put in its name.
export function buildOf(entry: string | undefined): string | undefined {
  return entry === undefined ? undefined : ENTRY_HASH.exec(entry.split(QUERY_OR_HASH, 1)[0]!)?.[1]
}
