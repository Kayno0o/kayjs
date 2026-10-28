import type { RevokeSessionResult, UserSession } from '../sessions'
import type { RequestState } from '../state'
import { listSessions, revokeSession } from '../sessions'

// `auth.sessions`: where the signed-in user is signed in.
export class SessionMethods {
  constructor(private readonly state: RequestState) {}

  // Where the signed-in user is signed in, this browser marked `current`; empty for a bearer token.
  async list(): Promise<UserSession[]> {
    return listSessions(this.state)
  }

  // Ends one of the signed-in user's sessions, effective on its next request; ending this one signs out. Refused with `not-found` when they have none with that id, and `signed-out` through a bearer token.
  async revoke(id: string): Promise<RevokeSessionResult> {
    return revokeSession(this.state, id, this.state.signOut)
  }
}
