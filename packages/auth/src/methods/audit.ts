import type { AuditCursorInput, AuditEntry } from '../events'
import type { RequestState } from '../state'
import { auditEntries } from '../events'

// `auth.audit`: what the audit log kept about the signed-in user.
export class AuditMethods {
  constructor(private readonly state: RequestState) {}

  // The signed-in user's own audit log, newest first, a page of `limit` (50 by default) before `before`, an instant or the last entry of the page (which tells entries of one millisecond apart); empty without the `audit` option.
  async list(options: { before?: AuditCursorInput, limit?: number } = {}): Promise<AuditEntry[]> {
    const record = await this.state.current()

    return record ? auditEntries(this.state.core, { ...options, userId: record.id }) : []
  }
}
