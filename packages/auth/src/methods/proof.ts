import type { Duration } from 'kay'
import type { Result } from '../failure'
import type { Proof, ProofFailure } from '../proof'
import type { RequestState } from '../state'
import { provedLately, reprove } from '../proof'

// `auth.proof`: whether the signed-in user proved themselves lately, and proving again before an app's own sensitive change.
export class ProofMethods {
  constructor(private readonly state: RequestState, private readonly milliseconds: (fresh: Duration) => number) {}

  // Whether this session signed in or re-proved its user within `fresh`, a duration such as `'5m'` (ten minutes when left out, as `account.export()` and the admin methods ask), for a page to show a form for `renew` first. A bearer token has no session to prove with, so it never has.
  async recent(fresh?: Duration): Promise<boolean> {
    return provedLately(this.state, fresh === undefined ? undefined : this.milliseconds(fresh))
  }

  // Re-proves the signed-in user, as before an app's own sensitive change: a proof counts for ten minutes, as a sign-in does.
  async renew(proof: Proof): Promise<Result<object, ProofFailure>> {
    const proved = await reprove(this.state, proof)

    return proved.ok ? { ok: true } : proved
  }
}
