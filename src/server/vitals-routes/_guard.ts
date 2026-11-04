import type { GuardContext } from '../../runtime/core'
import { vitalsSettings } from '../vitals'

// The screen is the app's guard's to open; without one it stays closed.
export default function vitalsGuard(ctx: GuardContext): unknown {
  const { guard } = vitalsSettings()

  if (!guard)
    return ctx.deny(403, 'vitals has no guard: give vitals() one, such as kayjs-auth\'s auth.guard()')

  return guard(ctx)
}
