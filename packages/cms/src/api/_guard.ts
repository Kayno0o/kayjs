import { guard } from 'kay'
import { READ_METHODS } from 'kay/library'
import { editRequested } from 'kay/server'
import { authors } from '../authors'
import { settings } from '../settings'

// Leaving edit mode writes nothing, so an edit link alone may do it; `/entries/preview/exit` is a save to a collection named preview.
const LEAVING = /\/api\/cms\/preview\/exit$/

// Entries are read in edit mode or by whom the app's guard admits, and written by whom the guard admits once there is one: an edit cookie or link is tied to no user.
export default guard(async (ctx) => {
  const { guard: admits, author } = settings()

  if (editRequested(ctx.request) && (!admits || READ_METHODS.has(ctx.request.method) || (ctx.request.method === 'POST' && LEAVING.test(ctx.url.pathname))))
    return

  if (!admits)
    return ctx.deny(403, 'Not in edit mode')

  await admits(ctx)

  const identity = await author?.(ctx)

  if (identity)
    authors.set(ctx.request, identity)
})
