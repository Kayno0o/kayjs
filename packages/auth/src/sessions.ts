import type { SessionSettings } from 'kay/server'
import type { Core } from './core'
import type { Device } from './device'
import type { RequestState } from './state'
import type { SessionRecord, UserRecord } from './store'
import { TOUCH_EVERY_MS } from './core'
import { readDevice } from './device'
import { log } from './log'

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

// Records a new sign-in of `record` from this browser, living `maxAge` seconds unseen or the session plugin's `maxAge`, and answers its id.
export async function openSession(core: Core, record: UserRecord, ip: string, userAgent: string, maxAge: number | null = null): Promise<string> {
  const now = new Date()
  const id = crypto.randomUUID()

  await core.store.sessions.create({ id, userId: record.id, version: record.sessionVersion, userAgent: userAgent.slice(0, USER_AGENT_MAX_LENGTH), ip, createdAt: now, lastSeenAt: now, maxAge })

  return id
}

// Whether `signedIn` still names a live session of `record`: not ended, not signed out everywhere since, seen within the session's lifetime and signed in within the session plugin's `absoluteMaxAge`. A visit is recorded on the way.
export async function liveSession(state: RequestState, found: SessionRecord | undefined, record: UserRecord, ip: string): Promise<boolean> {
  const { core } = state
  const now = Date.now()

  if (!found || found.userId !== record.id || !live(state.session.settings, found, record, now))
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
  const kept: SessionRecord[] = []

  for (const found of await state.core.store.sessions.listByUser(record.id)) {
    if (live(state.session.settings, found, record, now))
      kept.push(found)
    else
      await state.core.store.sessions.delete(record.id, found.id)
  }

  // Every lookup at once: the list waits on the slowest, not on their sum.
  const places = await Promise.all(kept.map(async found => locate(state.core, found.ip)))

  return kept.map((found, index) => ({
    id: found.id,
    current: found.id === signedIn?.session,
    device: readDevice(found.userAgent),
    userAgent: found.userAgent,
    ip: found.ip,
    place: places[index]!,
    createdAt: found.createdAt,
    lastSeenAt: found.lastSeenAt,
  }))
}

function live(settings: SessionSettings, session: SessionRecord, record: UserRecord, now: number): boolean {
  return session.version === record.sessionVersion && now - session.lastSeenAt.getTime() < (session.maxAge ?? settings.maxAge) * 1000 && now - session.createdAt.getTime() < settings.absoluteMaxAge * 1000
}

// A failure is logged, not thrown: a lookup service down must not hide the list.
async function locate(core: Core, ip: string): Promise<string | null> {
  try {
    return await core.locate?.(ip) ?? null
  }
  catch (error) {
    log.error('locate failed', error)

    return null
  }
}

// Keeps what the sign-in starting now chose about being remembered, for the session it opens; none leaves the session plugin's own lifetime.
export async function chooseRemember(state: RequestState, remember: boolean | undefined): Promise<void> {
  if (remember !== undefined)
    await state.session.set('authRemember', remember)
  else if (await state.session.get('authRemember') !== undefined)
    await state.session.unset('authRemember')
}

// Gives the session signing in the lifetime `remember` chose, back to the session plugin's `maxAge` without a choice since one may linger from a sign-in before, and answers it in seconds, null for that `maxAge`.
export async function applyLifetime(state: RequestState, remember: boolean | undefined): Promise<number | null> {
  const { core, session } = state

  if (remember === undefined) {
    await session.maxAge(`${session.settings.maxAge}s`)

    return null
  }

  await session.maxAge(remember ? `${core.rememberMaxAge}s` : 'browser')

  return remember ? core.rememberMaxAge : session.settings.browserMaxAge
}

// After a change to how the account is signed in to: every session the user holds ends but this browser's, and every bearer token with them, since one minted from a stolen session would outlive it.
export async function endOtherSessions(state: RequestState, record: UserRecord, patch: Partial<UserRecord> = {}): Promise<UserRecord | undefined> {
  const updated = await state.core.store.users.update(record.id, { ...patch, sessionVersion: record.sessionVersion + 1 })

  await revokeBearerTokens(state.core, record.id)

  if (updated)
    await state.renew(updated)

  return updated
}

export async function revokeBearerTokens(core: Core, userId: string): Promise<void> {
  const { bearerTokens } = core.store

  await core.store.oauth?.refresh.deleteForUser(userId)

  if (bearerTokens.deleteForUser)
    return bearerTokens.deleteForUser(userId)

  for (const token of await bearerTokens.listByUser(userId))
    await bearerTokens.delete(userId, token.id)
}

export async function removeIdentities(core: Core, userId: string): Promise<void> {
  const { identities } = core.store

  if (identities.deleteForUser)
    return identities.deleteForUser(userId)

  for (const identity of await identities.listByUser(userId))
    await identities.delete(identity.provider, identity.providerId)
}
