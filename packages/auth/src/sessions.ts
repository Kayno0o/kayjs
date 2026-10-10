import type { Core, SignedIn } from './core'
import type { Device } from './device'
import type { RequestState } from './state'
import type { SessionRecord, UserRecord } from './store'
import { readDevice } from './device'

// A visit is recorded at most this often, so a busy browser does not write on every request.
const TOUCH_EVERY_MS = 5 * 60 * 1000
const USER_AGENT_MAX_LENGTH = 512

// Where the user is signed in, as the app lists it.
export interface UserSession {
  id: string
  // Whether it is the browser asking.
  current: boolean
  device: Device
  userAgent: string
  ip: string
  // Where the address is, when the app's `locate` says.
  place: string | null
  createdAt: Date
  lastSeenAt: Date
}

// Records a new sign-in of `record` from this browser and answers its id.
export async function openSession(core: Core, record: UserRecord, ip: string, userAgent: string): Promise<string> {
  const now = new Date()
  const id = crypto.randomUUID()

  await core.store.sessions.create({ id, userId: record.id, version: record.sessionVersion, userAgent: userAgent.slice(0, USER_AGENT_MAX_LENGTH), ip, createdAt: now, lastSeenAt: now })

  return id
}

// Whether `signedIn` still names a live session of `record`: not ended, not signed out everywhere since, and seen within the session's lifetime. A visit is recorded on the way.
export async function liveSession(core: Core, signedIn: SignedIn & { session: string }, record: UserRecord, ip: string): Promise<boolean> {
  const found = await core.store.sessions.get(signedIn.session)
  const now = Date.now()

  if (!found || found.userId !== record.id || !live(core, found, record, now))
    return false

  if (now - found.lastSeenAt.getTime() > TOUCH_EVERY_MS || found.ip !== ip)
    await core.store.sessions.update(found.id, { lastSeenAt: new Date(now), ip })

  return true
}

// The signed-in user's sessions, oldest first; a session that ended without signing out, past its lifetime or signed out everywhere, is forgotten on the way.
export async function listSessions(state: RequestState): Promise<UserSession[]> {
  const record = await state.current()
  const signedIn = await state.session.get('auth')

  if (!record || state.via() !== 'session')
    return []

  const now = Date.now()
  const sessions: UserSession[] = []

  for (const found of await state.core.store.sessions.listByUser(record.id)) {
    if (!live(state.core, found, record, now)) {
      await state.core.store.sessions.delete(record.id, found.id)

      continue
    }

    sessions.push({
      id: found.id,
      current: found.id === signedIn?.session,
      device: readDevice(found.userAgent),
      userAgent: found.userAgent,
      ip: found.ip,
      place: await locate(state.core, found.ip),
      createdAt: found.createdAt,
      lastSeenAt: found.lastSeenAt,
    })
  }

  return sessions
}

function live(core: Core, session: SessionRecord, record: UserRecord, now: number): boolean {
  return session.version === record.sessionVersion && now - session.lastSeenAt.getTime() < core.sessionMaxAge * 1000
}

// A failure is logged, not thrown: a lookup service down must not hide the list.
async function locate(core: Core, ip: string): Promise<string | null> {
  try {
    return await core.locate?.(ip) ?? null
  }
  catch (error) {
    console.error('kayjs-auth: locate failed', error)

    return null
  }
}
