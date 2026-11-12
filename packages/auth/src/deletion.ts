import type { Duration } from 'kay'
import type { Core } from './core'
import type { AuthFailed } from './failure'
import type { RequestState } from './state'
import type { UserRecord } from './store'
import { report } from './events'
import { failed } from './failure'
import { sendAside, writing } from './mail'
import { pagePaths } from './pages'
import { securityNotice } from './securityNotice'

export interface AccountOptions {
  // How long `account.delete` leaves an account pending before it is deleted: a string such as '14d'. The user can cancel until then, and `beforeDelete`, the audit log and the account-deleted mail follow the deletion itself. Left out, the deletion is immediate.
  deleteAfter?: Duration | undefined
  // The page the mailed link to cancel opens, which cancels through `account.cancelDeletion()`: the prebuilt account data page by default.
  cancelPage?: string | undefined
}

export type CancelDeletionResult = { ok: true } | AuthFailed<'signed-out' | 'not-pending'>

// Where the mailed link leads: the app's own page, else the prebuilt account data page.
function cancelPageOf(core: Core): string {
  return core.deletion?.cancelPage ?? pagePaths(core.pages?.prefix ?? core.prefix).data
}

// Marks the user pending deletion until the grace period ends and mails them the way to cancel; an account pending already keeps its first deadline.
export async function scheduleDeletion(state: RequestState, record: UserRecord): Promise<{ ok: true, deleteAt: Date }> {
  const { core } = state

  if (record.deleteAt != null)
    return { ok: true, deleteAt: record.deleteAt }

  const deleteAt = new Date(Date.now() + core.deletion!.after * 1000)
  const updated = await core.store.users.update(record.id, { deleteAt }) ?? { ...record, deleteAt }

  state.adopt(updated)
  await report(state, updated, 'account-deletion-scheduled', deleteAt.toISOString())
  mailCancelLink(state, updated, deleteAt)

  return { ok: true, deleteAt }
}

// The mail half, to a verified address only and off the request's path.
function mailCancelLink(state: RequestState, record: UserRecord, deleteAt: Date): void {
  const { core } = state
  const mail = core.email
  const to = record.emailVerifiedAt === null ? null : record.email

  if (!mail || to === null)
    return

  const { locale, templates } = writing(mail, [record.locale, ...state.languages])
  const url = `${core.url}${cancelPageOf(core)}`
  const detail = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(deleteAt)

  sendAside(mail, () => ({ to, kind: 'cancel-deletion', name: core.name, locale, url, detail, ...templates['cancel-deletion']({ name: core.name, email: to, url, detail, locale }) }), 'cancel-deletion')
}

// Takes the pending mark off the signed-in user, and tells them.
export async function cancelDeletion(state: RequestState): Promise<CancelDeletionResult> {
  const record = await state.current()

  if (!record)
    return failed('signed-out')

  if (record.deleteAt == null)
    return failed('not-pending')

  const updated = await state.core.store.users.update(record.id, { deleteAt: null }) ?? { ...record, deleteAt: null }

  state.adopt(updated)
  await securityNotice(state, updated, 'account-deletion-cancelled')

  return { ok: true }
}
