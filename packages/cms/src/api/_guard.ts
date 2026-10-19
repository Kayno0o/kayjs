import type { GuardContext } from 'kay'
import { guard } from 'kay'
import { READ_METHODS } from 'kay/library'
import { editedCollections, editRequested } from 'kay/server'
import { wording } from 'kay/words'
import { authors } from '../authors'
import { settings } from '../settings'

// Leaving edit mode writes nothing, so an edit link alone may do it; `/entries/preview/exit` is a save to a collection named preview.
const LEAVING = /\/api\/cms\/preview\/exit$/

// What the editor reads: an entry of a collection, and the rules for an upload.
const ENTRY = /\/api\/cms\/entries\/([^/]+)\/[^/]+$/
const UPLOAD_RULES = /\/api\/cms\/files\/rules$/

// Whether the edit cookie may read this request: only the entries of a collection the pages rendered in edit mode read, since it is tied to no user and a preview link goes to people the app has not signed in.
function mayRead(ctx: GuardContext): boolean {
  if (UPLOAD_RULES.test(ctx.url.pathname))
    return true

  const name = ENTRY.exec(ctx.url.pathname)?.[1]

  if (name === undefined)
    return false

  try {
    return editedCollections(ctx.request).has(decodeURIComponent(name))
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

// An edit cookie or link reads the collections the page it opened renders, leaves edit mode, and in development writes while the app has no guard; every other request is whom the app's guard admits, and a production server without one admits no write at all.
export default guard(async (ctx) => {
  const { guard: admits, author } = settings()
  const { method } = ctx.request
  const editing = editRequested(ctx.request)

  if (editing) {
    if (method === 'POST' && LEAVING.test(ctx.url.pathname))
      return

    if (READ_METHODS.has(method) ? mayRead(ctx) : !admits && process.env.NODE_ENV !== 'production')
      return
  }

  if (!admits)
    return ctx.deny(403, refusal(editing, READ_METHODS.has(method)))

  await admits(ctx)

  const identity = await author?.(ctx)

  if (identity)
    authors.set(ctx.request, identity)
})
