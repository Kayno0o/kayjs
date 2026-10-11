import { guard } from 'kay'
import { editRequested } from 'kay/server'
import { settings } from '../settings'

// Entries are read and written for a request kay let into edit mode, or one the app's guard given to cms() admits.
export default guard(async (ctx) => {
  if (editRequested(ctx.request))
    return

  const { guard: admits } = settings()

  if (!admits)
    return ctx.deny(403, 'Not in edit mode')

  return admits(ctx)
})
