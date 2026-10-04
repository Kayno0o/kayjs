import type { Session } from 'kay/server'
import type { AuthSessionData, Core } from './core'
import type { UserRecord } from './store'

// What a flow works with for one request.
export interface RequestState {
  core: Core
  session: Session<AuthSessionData>
  // Who is asking, as rate limits count them.
  client: string
  current: () => Promise<UserRecord | null>
  // Signs `record` in and answers where the browser goes next.
  complete: (record: UserRecord, redirect: string) => Promise<string>
  // Keeps this session signed in as `record` after its session version was raised, when it is that user's.
  renew: (record: UserRecord) => Promise<void>
}
