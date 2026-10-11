import type { Session } from 'kay/server'
import type { AuthSessionData, Core } from './core'
import type { UserRecord } from './store'

// What a flow works with for one request.
export interface RequestState {
  core: Core
  session: Session<AuthSessionData>
  // Who is asking, as rate limits count them.
  client: string
  // The client's address as it is, for the list of where the user is signed in.
  address: string
  userAgent: string
  // The languages the browser asks for, most wanted first.
  languages: string[]
  current: () => Promise<UserRecord | null>
  // How the current user was read, once `current` has been.
  via: () => 'session' | 'bearer' | null
  // Signs `record` in, `method` saying how for the `signed-in` event, and answers where the browser goes next; refused while an admin bans them.
  complete: (record: UserRecord, redirect: string, method: string) => Promise<{ ok: true, redirect: string } | { ok: false, error: 'banned' }>
  // Keeps this session signed in as `record` after its session version was raised, when it is that user's.
  renew: (record: UserRecord) => Promise<void>
}
