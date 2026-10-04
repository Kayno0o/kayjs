import type { Core } from './core'
import type { SecurityEvent } from './mail'
import type { UserRecord } from './store'
import { publicUser } from './core'

// Tells the user and the app of a change to what protects the account; mail goes to a verified address only, so a typo never warns a stranger.
export async function notify(core: Core, record: UserRecord, event: SecurityEvent, detail?: string, to = record.emailVerifiedAt === null ? null : record.email): Promise<void> {
  await core.onEvent?.(event, publicUser(record), detail)

  const mail = core.email

  if (!mail || to === null)
    return

  await mail.mailer.send({ to, kind: event, ...mail.templates[event]({ site: core.site, email: to, detail }) })
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
