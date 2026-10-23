import type { Notification } from 'kay/server'
import type { ApprovedClient } from './authorize/grants'
import type { BearerToken } from './bearer'
import type { User } from './core'
import type { AuditEntry } from './events'
import type { MailingSubscription } from './mail'
import type { Invitation, Membership } from './organizations'
import type { Passkey } from './passkeys'
import type { UserSession } from './sessions'
import type { RequestState } from './state'
import { notifications } from 'kay/server'
import { listTokens } from './bearer'
import { linkedUser } from './core'
import { impersonatorOf } from './events'
import { spend } from './limits'
import { provedLately } from './proof'
import { listSessions } from './sessions'

// More than a person's year of sign-ins, so only a bot's account is cut short.
const AUDIT_EXPORT_MAX = 100_000
// The most a person keeps, as kay's notifications hold the newest 200 each.
const NOTIFICATIONS_EXPORT_MAX = 200

// Everything kayjs-auth keeps about a user, secrets left out, and what the app's `exportData` adds.
export interface DataExport {
  exportedAt: Date
  user: User & { createdAt: Date, emailVerifiedAt: Date | null, twoFactorEnabledAt: Date | null }
  identities: { provider: string, providerId: string, createdAt: Date }[]
  sessions: UserSession[]
  passkeys: Passkey[]
  tokens: BearerToken[]
  recoveryCodesLeft: number
  // The apps the user approved to act as them; empty without an OAuth server.
  grants: ApprovedClient[]
  // The last ban an admin set, with the reason given, once its time has passed: a user under a ban in force cannot sign in to export. Null when never barred.
  ban: { at: Date, until: Date | null, reason: string | null } | null
  // Empty without the `organizations` option.
  organizations: Membership[]
  // The invitations to the user's address, expired ones included, and those they sent; empty without the `organizations` option.
  invitations: { received: Invitation[], sent: Invitation[] }
  // The user's notifications, the newest 200 of them.
  notifications: Notification[]
  // The mailing lists of kayjs-mail their address is on, pending ones included; empty without kayjs-mail.
  mailingLists: MailingSubscription[]
  // Empty without the `audit` option.
  audit: AuditEntry[]
  app: unknown
}

// Not for an admin acting as the user: they see what the user sees, not a copy of everything kept about them.
// Only within ten minutes of signing in or re-proving, so a session left open or stolen does not download everything the account holds.
export async function exportData(state: RequestState): Promise<{ ok: true, data: DataExport } | { ok: false, error: 'signed-out' | 'limited' | 'impersonating' | 'stale' }> {
  const { core } = state
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  if (await impersonatorOf(state) !== undefined)
    return { ok: false, error: 'impersonating' }

  if (!await provedLately(state))
    return { ok: false, error: 'stale' }

  if (await spend(core.store, `export:${record.id}`, core.limits.export))
    return { ok: false, error: 'limited' }

  const user = await linkedUser(core, record)
  const organizations = core.organizations ? await import('./organizations') : undefined

  return {
    ok: true,
    data: {
      exportedAt: new Date(),
      user: { ...user, createdAt: record.createdAt, emailVerifiedAt: record.emailVerifiedAt, twoFactorEnabledAt: record.totpEnabledAt },
      identities: (await core.store.identities.listByUser(record.id)).map(identity => ({ provider: identity.provider, providerId: identity.providerId, createdAt: identity.createdAt })),
      sessions: await listSessions(state),
      passkeys: await (await import('./passkeys')).listPasskeys(state),
      tokens: await listTokens(state),
      recoveryCodesLeft: await core.store.recoveryCodes.count(record.id),
      grants: core.store.oauth ? await (await import('./authorize/grants')).approvedClients(state) : [],
      ban: record.bannedAt === null ? null : { at: record.bannedAt, until: record.bannedUntil, reason: record.banReason },
      organizations: organizations ? await organizations.listMemberships(state) : [],
      invitations: organizations ? await organizations.exportedInvitations(state) : { received: [], sent: [] },
      notifications: await notifications.list(record.id, { limit: NOTIFICATIONS_EXPORT_MAX }),
      mailingLists: record.email !== null && record.email !== '' && core.email?.mailer.subscriptions ? await core.email.mailer.subscriptions(record.email) : [],
      audit: core.audit ? (await core.store.audit!.list({ userId: record.id, limit: AUDIT_EXPORT_MAX })).map(entry => ({ ...entry, event: entry.event as AuditEntry['event'] })) : [],
      app: await core.onExport?.(user) ?? null,
    },
  }
}
