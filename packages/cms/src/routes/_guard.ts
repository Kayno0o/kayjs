import { guard } from 'kay'
import { overHttps } from 'kay/library'
import { hintCookie } from '../page-link'
import { settings } from '../settings'

// The screens are the app's guard's to open; without one they stay closed.
export default guard(async (ctx) => {
  const { guard: admits, pageLink } = settings()

  if (!admits)
    return ctx.deny(403, 'kayjs-cms has no guard: give cms() one, such as kayjs-auth\'s auth.guard()')

  await admits(ctx)

  // An editor the guard let in is marked for the pages they read next, which show them the link into edit mode.
  if (pageLink)
    ctx.cookies.set(hintCookie(overHttps(ctx.request)))
})
