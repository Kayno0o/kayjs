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

  const mail = core.email

  if (!mail || to === null)
    return

  // A new sign-in links to where the user ends the sessions they do not know.
  const url = event === 'new-sign-in' && core.sessionsPage !== undefined ? `${core.url}${core.sessionsPage}` : undefined

  const { locale, templates } = writing(mail, [record.locale, ...state.languages])

  sendAside(mail, () => ({ to, kind: event, site: core.site, locale, ...url === undefined ? {} : { url }, ...detail === undefined ? {} : { detail }, ...templates[event]({ site: core.site, email: to, detail, url, locale }) }), event)
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
