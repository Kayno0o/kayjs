import type { Auth } from '../../../auth'
import { guard } from 'kay'

// The account pages are the signed-in user's own, through their session rather than a bearer token: anyone else signs in first and comes back.
export default guard<{ auth: Auth }>(async (ctx) => {
  const { auth } = ctx.locals

  if (await auth.via() === 'session')
    return

  if (ctx.request.method === 'GET')
    ctx.redirect(auth.signInUrl())

  ctx.deny(401)
})
