import type { BareUser, Core } from './core'
import type { PolicyContext } from './types'

// Whether `user` must have two-factor on and has not: `wanted` is a guard's own say (true asks of everyone it lets through, false asks of no one), else the `twoFactor.require` of the app decides by the user's roles. A guest, a user mid-enrolment (the secret set up, the code not yet given) and one signed in by a passkey all lack it, as `forwardAuth.requireTwoFactor` reads it. Switched off with `twoFactor: false`, it asks of no one.
export async function lacksTwoFactor(core: Core, user: BareUser, wanted?: boolean, ctx: PolicyContext = {}): Promise<boolean> {
  if (user.twoFactor || wanted === false || !core.switches.twoFactor)
    return false

  if (wanted === true)
    return true

  return core.twoFactorRequire !== undefined && core.access.authorize(user, core.twoFactorRequire, 'write', ctx)
}
