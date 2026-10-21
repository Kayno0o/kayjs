import type { GuardContext } from 'kay'
import { guard } from 'kay'
import { READ_METHODS, underKayDev } from 'kay/library'
import { editedEntry, editRequested } from 'kay/server'
import { wording } from 'kay/words'
import { authors } from '../authors'
import { settings } from '../settings'

// Leaving edit mode writes nothing, so an edit link alone may do it; `/entries/preview/exit` is a save to a collection named preview.
const LEAVING = /\/api\/cms\/preview\/exit$/

// What the editor reads: an entry of a collection, and the rules for an upload.
const ENTRY = /\/api\/cms\/entries\/([^/]+)\/([^/]+)$/
const UPLOAD_RULES = /\/api\/cms\/files\/rules$/
// The module an editor's browser loads on each page, which holds nothing private.
const PAGE_LINK_MODULE = /\/api\/cms\/editor\/module\.js$/

// Whether the edit cookie may read this request: only an entry the pages rendered in edit mode read, since it is tied to no user and a preview link goes to people the app has not signed in.
function mayRead(ctx: GuardContext): boolean {
  if (UPLOAD_RULES.test(ctx.url.pathname))
    return true

  const [, collection, slug] = ENTRY.exec(ctx.url.pathname) ?? []

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

  return reading ? wording('cms.guard.notOnPage', 'Not an entry of the pages shown in edit mode') : wording('cms.guard.needsGuard', 'Saving needs cms({ guard })')
}

// An edit cookie or link reads the entries the pages it opened render, leaves edit mode, and under `kay dev` writes while the app has no guard; every other request is whom the app's guard admits, and any other server without one admits no write at all.
export default guard(async (ctx) => {
  const { guard: admits, author } = settings()
  const { method } = ctx.request

  if (method === 'GET' && PAGE_LINK_MODULE.test(ctx.url.pathname))
    return

  const editing = editRequested(ctx.request)

  if (editing) {
    if (method === 'POST' && LEAVING.test(ctx.url.pathname))
      return

    if (READ_METHODS.has(method) ? mayRead(ctx) : !admits && underKayDev())
      return
  }

  if (!admits)
    return ctx.deny(403, refusal(editing, READ_METHODS.has(method)))

  await admits(ctx)

  const identity = await author?.(ctx)

  if (identity)
    authors.set(ctx.request, identity)
})
