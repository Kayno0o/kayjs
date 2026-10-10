import type { SecurityEvent } from './mail'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { report } from './events'
import { writing } from './mail'

// Tells the user and the app of a change to what protects the account; mail goes to a verified address only, so a typo never warns a stranger.
// A failure is logged, not thrown: the change is made by then, and a mail outage must not turn every sign-in into an error.
export async function notify(state: RequestState, record: UserRecord, event: SecurityEvent, detail?: string, to = record.emailVerifiedAt === null ? null : record.email): Promise<void> {
  const { core } = state

  await report(state, record, event, detail)

  const mail = core.email

  if (!mail || to === null)
    return

  // A new sign-in links to where the user ends the sessions they do not know.
  const url = event === 'new-sign-in' && core.sessionsPage !== undefined ? `${core.url}${core.sessionsPage}` : undefined

  try {
    const { locale, templates } = writing(mail, [record.locale, ...state.languages])

    await mail.mailer.send({ to, kind: event, locale, ...url === undefined ? {} : { url }, ...templates[event]({ site: core.site, email: to, detail, url, locale }) })
  }
  catch (error) {
    console.error(`kayjs-auth: mailing ${event} failed`, error)
  }
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
