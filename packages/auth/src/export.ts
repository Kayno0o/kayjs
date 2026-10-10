import type { BearerToken } from './bearer'
import type { User } from './core'
import type { AuditEntry } from './events'
import type { Passkey } from './passkeys'
import type { UserSession } from './sessions'
import type { RequestState } from './state'
import { listTokens } from './bearer'
import { publicUser } from './core'
import { listPasskeys } from './passkeys'
import { listSessions } from './sessions'

// More than a person's year of sign-ins, so only a bot's account is cut short.
const AUDIT_EXPORT_MAX = 100_000

// Everything kayjs-auth keeps about a user, secrets left out, and what the app's `onExport` adds.
export interface DataExport {
  exportedAt: Date
  user: User & { createdAt: Date, emailVerifiedAt: Date | null, twoFactorEnabledAt: Date | null }
  identities: { provider: string, providerId: string, createdAt: Date }[]
  sessions: UserSession[]
  passkeys: Passkey[]
  tokens: BearerToken[]
  recoveryCodesLeft: number
  // Empty without the `audit` option.
  audit: AuditEntry[]
  app: unknown
}

export async function exportData(state: RequestState): Promise<{ ok: true, data: DataExport } | { ok: false, error: 'signed-out' }> {
  const { core } = state
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return { ok: false, error: 'signed-out' }

  const user = publicUser(record)

  return {
    ok: true,
    data: {
      exportedAt: new Date(),
      user: { ...user, createdAt: record.createdAt, emailVerifiedAt: record.emailVerifiedAt, twoFactorEnabledAt: record.totpEnabledAt },
      identities: (await core.store.identities.listByUser(record.id)).map(identity => ({ provider: identity.provider, providerId: identity.providerId, createdAt: identity.createdAt })),
      sessions: await listSessions(state),
      passkeys: await listPasskeys(state),
      tokens: await listTokens(state),
      recoveryCodesLeft: await core.store.recoveryCodes.count(record.id),
      audit: core.audit ? (await core.store.audit!.list({ userId: record.id, limit: AUDIT_EXPORT_MAX })).map(entry => ({ ...entry, event: entry.event as AuditEntry['event'] })) : [],
      app: await core.onExport?.(user) ?? null,
    },
  }
}
