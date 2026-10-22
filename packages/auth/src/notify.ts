import type { SecurityEvent } from './mail'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { report } from './events'
import { sendAside, writing } from './mail'

// Tells the user and the app of a change to what protects the account; mail goes to a verified address only, so a typo never warns a stranger.
// The mail leaves off the request's path, so a slow relay never delays the response and a failure is only logged.
export async function notify(state: RequestState, record: UserRecord, event: SecurityEvent, detail?: string, to = record.emailVerifiedAt === null ? null : record.email, actor?: UserRecord): Promise<void> {
  const { core } = state

  await report(state, record, event, detail, actor)

  // A new sign-in links to where the user ends the sessions they do not know.
  const url = event === 'new-sign-in' && core.sessionsPage !== undefined ? `${core.url}${core.sessionsPage}` : undefined

  mailNotice(core, state.languages, record, event, detail, to, url)
}

// The mail half of `notify`, for a notice outside a request: `languages` are the ones to write in after the user's own.
export function mailNotice(core: RequestState['core'], languages: readonly string[], record: UserRecord, event: SecurityEvent, detail?: string, to = record.emailVerifiedAt === null ? null : record.email, url?: string): void {
  const mail = core.email

  if (!mail || to === null)
    return

  const { locale, templates } = writing(mail, [record.locale, ...languages])

  sendAside(mail, () => ({ to, kind: event, name: core.name, site: core.name, locale, ...url === undefined ? {} : { url }, ...detail === undefined ? {} : { detail }, ...templates[event]({ name: core.name, site: core.name, email: to, detail, url, locale }) }), event)
}

// Mails a sign-in from a device or network the account has not used before, then remembers this one.
export async function noteSignIn(state: RequestState, record: UserRecord): Promise<void> {
  const { core } = state
  const fingerprint = core.keys.fingerprint(`${state.client}\n${state.userAgent}`)

  if (record.lastSignIn === fingerprint)
    return

  await core.store.users.update(record.id, { lastSignIn: fingerprint })

  // The first sign-in has nothing to compare against.
  if (record.lastSignIn !== null)
    await notify(state, record, 'new-sign-in')
}
