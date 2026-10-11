import { guard } from 'kay'
import { settings } from '../settings'

// The screens are the app's guard's to open; without one they stay closed.
export default guard(async (ctx) => {
  const { guard: admits } = settings()

  if (!admits)
    return ctx.deny(403, 'kayjs-cms has no guard: give cms() one, such as kayjs-auth\'s auth.guard()')

  return admits(ctx)
})
