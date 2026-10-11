import type { Auth } from '../../../auth'
import { guard } from 'kay'

// The account pages are the signed-in user's own, through their session rather than a bearer token: anyone else signs in first and comes back.
export default guard(async (ctx) => {
  const { auth } = ctx.locals as unknown as { auth: Auth }

  if (await auth.via() === 'session')
    return

  if (ctx.request.method === 'GET') {
    const signIn = auth.features().signInPage

    ctx.redirect(`${signIn}${signIn.includes('?') ? '&' : '?'}redirect=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`)
  }

  ctx.deny(401)
})
