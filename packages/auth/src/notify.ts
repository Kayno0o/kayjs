import type { Core } from './core'
import type { SecurityEvent } from './mail'
import type { UserRecord } from './store'
import { publicUser } from './core'

// Tells the user and the app of a change to what protects the account; mail goes to a verified address only, so a typo never warns a stranger.
// A failure is logged, not thrown: the change is made by then, and a mail outage must not turn every sign-in into an error.
export async function notify(core: Core, record: UserRecord, event: SecurityEvent, detail?: string, to = record.emailVerifiedAt === null ? null : record.email): Promise<void> {
  try {
    await core.onEvent?.(event, publicUser(record), detail)
  }
  catch (error) {
    console.error(`kayjs-auth: onEvent failed for ${event}`, error)
  }

  const mail = core.email

  if (!mail || to === null)
    return

  try {
    await mail.mailer.send({ to, kind: event, ...mail.templates[event]({ site: core.site, email: to, detail }) })
  }
  catch (error) {
    console.error(`kayjs-auth: mailing ${event} failed`, error)
  }
}

// Mails a sign-in from a device or network the account has not used before, then remembers this one.
export async function noteSignIn(core: Core, record: UserRecord, client: string, userAgent: string): Promise<void> {
  const fingerprint = core.keys.fingerprint(`${client}\n${userAgent}`)

  if (record.lastSignIn === fingerprint)
    return

  await core.store.users.update(record.id, { lastSignIn: fingerprint })

  // The first sign-in has nothing to compare against.
  if (record.lastSignIn !== null)
    await notify(core, record, 'new-sign-in')
}
