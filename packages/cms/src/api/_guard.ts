import type { GuardContext } from 'kay'
import type { Action } from '../roles'
import { apiUrl, guard } from 'kay'
import { READ_METHODS, underKayDev } from 'kay/library'
import { editedEntry, editRequested } from 'kay/server'
import { wording } from 'kay/words'
import { forbidden, may, memberOf, routePath } from '../access'
import { authors } from '../authors'
import { leavesPublication, restrain } from '../publishing'
import { settings } from '../settings'
import devApi from './dev'
import iconsApi from './icons'
import previewApi from './preview'

// The modules whose mount tells where the cms is served, the lightest ones: an app can replace any of them with its own, which is then not mounted, so the first one that is mounted gives the root.
const ANCHORS: [module: unknown, name: string][] = [[devApi, 'dev'], [previewApi, 'preview'], [iconsApi, 'icons']]

// Where the cms's modules are mounted (`/api/cms`, `/v1/cms` under an `apiPath`, behind the `base`), or undefined when none of its anchor modules is mounted.
function mountRoot(): string | undefined {
  for (const [module, name] of ANCHORS) {
    try {
      return apiUrl(module, '/').slice(0, -(name.length + 1))
    }
    catch {
      // not mounted, try the next
    }
  }

  return undefined
}

// The path below the cms's own mount (`/entries/posts/hello`), whatever `base` and `apiPath` put before it, so a collection or slug named like a route never reads as one.
// Empty when the mount is unknown or not in the path, which no route pattern matches.
function ownPath(path: string): string {
  const root = mountRoot()

  if (root === undefined)
    return ''

  const at = path.indexOf(`${root}/`)

  return at < 0 ? '' : path.slice(at + root.length)
}

// Leaving edit mode writes nothing, so an edit link alone may do it; `/entries/preview/exit` is a save to a collection named preview.
const LEAVING = /^\/preview\/exit$/

// What the editor reads: an entry of a collection, and the rules for an upload.
const ENTRY = /^\/entries\/([^/]+)\/([^/]+)$/
const UPLOAD_RULES = /^\/files\/rules$/
const ICON_PAGE = /^\/icons$/
// The preview's images, read from the folder of the entry being edited.
const PREVIEW_IMAGE = /^\/markdown\/image$/
// The module an editor's browser loads on each page, which holds nothing private.
const PAGE_LINK_MODULE = /^\/editor\/module\.js$/
// What the dev tool's tab reads, which answers under `kay dev` alone and holds the edit mode's state and the tab's texts.
const DEV_STATE = /^\/dev$/
const EDITOR_CAN = /^\/editor\/can$/

// What a role may be limited from, by the route: publishing, deleting, uploading and the redirects, which a rename makes.
// Sharing a draft shows what is not published, so it is a publisher's.
const PUBLISH = /^\/entries\/[^/]+\/[^/]+\/(?:publish|unpublish|share)$/
const ENTRY_RENAME = /^\/entries\/[^/]+\/[^/]+\/rename$/
const REDIRECTS = /^\/redirects(?:\/|$)/
const UPLOAD = /^\/files\/[^/]+$/
const MEDIA_RENAME = /^\/files\/media\/rename$/
const RESTORE = /^\/(?:history\/[^/]+\/[^/]+|trash\/[^/]+\/[^/]+)\/restore$/
const UNUSED_UPLOADS = /^\/files\/unused\/delete$/

// Which action of `cms({ roles })` a request needs, from its method and path as the router reads them.
function actionOf(method: string, path: string): Action | undefined {
  if (REDIRECTS.test(path) || (method === 'POST' && ENTRY_RENAME.test(path)))
    return 'redirects'

  if ((method === 'DELETE' && ENTRY.test(path)) || UNUSED_UPLOADS.test(path))
    return 'delete'

  if (method === 'POST' && PUBLISH.test(path))
    return 'publish'

  return method === 'POST' && (UPLOAD.test(path) || MEDIA_RENAME.test(path)) ? 'upload' : undefined
}

// Whether the edit cookie may read this request: only an entry the pages rendered in edit mode read, since it is tied to no user and a preview link goes to people the app has not signed in.
function mayRead(ctx: GuardContext): boolean {
  const path = ownPath(ctx.url.pathname)

  if (UPLOAD_RULES.test(path) || ICON_PAGE.test(path) || (PREVIEW_IMAGE.test(path) && underKayDev()))
    return true

  const [, collection, slug] = ENTRY.exec(path) ?? []

  if (collection === undefined || slug === undefined)
    return false

  try {
    return editedEntry(ctx.request, decodeURIComponent(collection), decodeURIComponent(slug))
  }
  catch {
    return false
  }
}

function refusal(editing: boolean, reading: boolean): string {
  if (!editing)
    return wording('cms.guard.notEditing', 'Not in edit mode')

  return reading ? wording('cms.guard.notOnPage', 'Not an entry of the pages shown in edit mode') : wording('cms.guard.needsGuard', 'Saving needs cms({ role }) or cms({ guard })')
}

// An edit cookie or link reads the entries the pages it opened render, leaves edit mode, and under `kay dev` writes while the app has no guard; every other request is whom the app's guard admits, and any other server without one admits no write at all.
export default guard(async (ctx) => {
  const { guard: admits, author } = settings()
  const { method } = ctx.request

  if (method === 'GET' && (PAGE_LINK_MODULE.test(ownPath(ctx.url.pathname)) || DEV_STATE.test(ownPath(ctx.url.pathname))))
    return

  const editing = editRequested(ctx.request)

  if (editing) {
    if (method === 'POST' && LEAVING.test(ownPath(ctx.url.pathname)))
      return

    if (READ_METHODS.has(method) ? mayRead(ctx) : !admits && underKayDev())
      return
  }

  if (!admits)
    return ctx.deny(403, refusal(editing, READ_METHODS.has(method)))

  await admits(ctx)

  if (settings().roles !== undefined) {
    // Read now so the route that tells what the person may do has it; every other route reads it only when it needs it.
    if (method === 'GET' && EDITOR_CAN.test(ownPath(ctx.url.pathname)))
      await memberOf(ctx)

    const path = ownPath(routePath(ctx.url))

    // A request the guard cannot place below the cms's mount would skip every role check, so it is refused.
    if (path === '')
      return ctx.deny(403, wording('cms.guard.unplaced', 'The cms could not place this request among its routes'))

    const needed = actionOf(method, path)

    // Restoring undoes an edit or a delete, which any editor may; what it restores never publishes or withdraws for a role that may not.
    const restoring = method === 'POST' && RESTORE.test(path)

    if (restoring && !await may(ctx, 'publish'))
      restrain(ctx.request)

    if (needed !== undefined && !await may(ctx, needed))
      return forbidden(ctx, needed)

    // A save that flips the draft flag or a publish date is a publish as much as the route is.
    if (method === 'POST' && needed === undefined && !await may(ctx, 'publish') && !await leavesPublication(ctx.request, path))
      return forbidden(ctx, 'publish')
  }

  const identity = await author?.(ctx)

  if (identity)
    authors.set(ctx.request, identity)
})
