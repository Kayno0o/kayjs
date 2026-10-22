import { guard } from 'kay'
import { overHttps } from 'kay/library'
import { sendToSignIn } from '../access'
import { hintCookie } from '../page-link'
import { settings } from '../settings'

// The screens are the app's guard's to open; without one they stay closed. A visitor it turns away as anonymous goes to sign in and comes back to this page.
export default guard(async (ctx) => {
  const { guard: admits, pageLink } = settings()

  if (!admits)
    return ctx.deny(403, 'kayjs-cms has no guard: give cms() a kayjs-auth role, cms({ role: \'editor\' }), or a guard such as passwordGuard()')

  try {
    await admits(ctx)
  }
  catch (error) {
    sendToSignIn(ctx, error)

    throw error
  }

  // An editor the guard let in is marked for the pages they read next, which show them the link into edit mode.
  if (pageLink)
    ctx.cookies.set(hintCookie(overHttps(ctx.request)))
})
