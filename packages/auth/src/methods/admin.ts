import type { AdminAuditLogResult, BanResult, DeleteResult, GetUserResult, ImpersonateResult, ListUsersResult, RoleResult, UnbanResult } from '../admin'
import type { AuditCursorInput } from '../events'
import type { RequestState } from '../state'
import { load } from '../load'

// `auth.admin`: what the `admin` option's users may do to other users, every method answering `forbidden` for anyone else.
export class AdminMethods<Role extends string = string> {
  constructor(private readonly state: RequestState) {}

  // The users, newest first, a page of `limit` (50 by default) from `offset`; `search` matches part of an email or a username, or a whole id.
  async listUsers(query: { search?: string, offset?: number, limit?: number } = {}): Promise<ListUsersResult> {
    return (await load.admin()).listUsers(this.state, query)
  }

  // One user; `admin` tells whether they meet the `admin` option, whom an admin can neither ban, impersonate nor delete.
  async getUser(userId: string): Promise<GetUserResult> {
    return (await load.admin()).getUser(this.state, userId)
  }

  // The roles an admin may give, those `roles` declares; none without it.
  roles(): string[] {
    return [...this.state.core.roles ?? []]
  }

  // Gives a user a role the app declares, effective on their next request.
  async grantRole(userId: string, role: Role): Promise<RoleResult> {
    return (await load.admin()).changeRole(this.state, userId, role, true)
  }

  // Takes a role back; one that would leave the admin asking no longer an admin is refused (`self`), and one that races another admin's revoke and would leave none is undone (`last-admin`).
  async revokeRole(userId: string, role: Role): Promise<RoleResult> {
    return (await load.admin()).changeRole(this.state, userId, role, false)
  }

  // Bars a user from signing in, for good or `until` then, and signs them out everywhere; another admin is refused.
  async ban(userId: string, options: { reason?: string, until?: Date } = {}): Promise<BanResult> {
    return (await load.admin()).banUser(this.state, userId, options)
  }

  async unban(userId: string): Promise<UnbanResult> {
    return (await load.admin()).unbanUser(this.state, userId)
  }

  // Deletes a user with everything kayjs-auth keeps for them, calling `onDelete` and mailing them the account-deleted notice; oneself and another admin are refused.
  async deleteUser(userId: string): Promise<DeleteResult> {
    return (await load.admin()).deleteUser(this.state, userId)
  }

  // Everyone's audit log, or `userId`'s, newest first.
  async auditLog(query: { userId?: string, before?: AuditCursorInput, limit?: number } = {}): Promise<AdminAuditLogResult> {
    return (await load.admin()).adminAuditLog(this.state, query)
  }

  // Signs this browser in as `userId`, the admin's own sign-in kept for `admin.stopImpersonating`; 'stale' unless the admin signed in or re-proved lately. Nothing that takes a proof works meanwhile, and another admin cannot be impersonated.
  async impersonate(userId: string): Promise<ImpersonateResult> {
    return (await load.admin()).impersonate(this.state, userId)
  }

  // Signs the admin back in as themselves; signed out when their own sign-in ended meanwhile. False when not impersonating.
  async stopImpersonating(): Promise<boolean> {
    return (await load.admin()).stopImpersonating(this.state)
  }
}
