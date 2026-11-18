import type { AdminChangeFailure, AdminFailure, ManagedUser } from '../admin'
import type { User } from '../core'
import type { AuditCursorInput, AuditEntry } from '../events'
import type { Result } from '../failure'
import type { RequestState } from '../state'
import { load } from '../load'

// `auth.admin`: what the `admin` option's users may do to other users, every method answering `forbidden` for anyone else.
export class AdminMethods<Role extends string = string, UserData extends object = Record<string, unknown>> {
  constructor(private readonly state: RequestState, private readonly asking: () => Promise<User<UserData>>) {}

  // The signed-in admin, as themselves, for an admin page to ask for: 404 while the `admin` option names no one (a `Denied`, which a plain Elysia app answers too), a visitor sent to sign in as `requireUser()` does, and 403 for anyone else, an admin acting as a user and a bearer token included.
  async require(): Promise<User<UserData>> {
    return this.asking()
  }

  // The users, newest first, a page of `limit` (50 by default) from `offset`; `search` matches part of an email or a username, or a whole id.
  async listUsers(query: { search?: string, offset?: number, limit?: number } = {}): Promise<Result<{ users: ManagedUser[], total: number }, 'forbidden' | 'two-factor-required'>> {
    return (await load.admin()).listUsers(this.state, query)
  }

  // One user; `admin` tells whether they meet the `admin` option, whom an admin can neither ban, impersonate nor delete.
  async getUser(userId: string): Promise<Result<{ user: ManagedUser, admin: boolean }, AdminFailure>> {
    return (await load.admin()).getUser(this.state, userId)
  }

  // The roles an admin may give, those `roles` declares; none without it.
  listRoles(): string[] {
    return [...this.state.core.roles ?? []]
  }

  // Gives a user a role the app declares, effective on their next request.
  async grantRole(userId: string, role: Role): Promise<Result<{ user: ManagedUser }, AdminChangeFailure | 'unknown-role' | 'self' | 'last-admin'>> {
    return (await load.admin()).changeRole(this.state, userId, role, true)
  }

  // Takes a role back; one that would leave the admin asking no longer an admin is refused (`self`), and one that races another admin's revoke and would leave none is undone (`last-admin`).
  async revokeRole(userId: string, role: Role): Promise<Result<{ user: ManagedUser }, AdminChangeFailure | 'unknown-role' | 'self' | 'last-admin'>> {
    return (await load.admin()).changeRole(this.state, userId, role, false)
  }

  // Bars a user from signing in, for good or `until` then, and signs them out everywhere; another admin is refused.
  async ban(userId: string, options: { reason?: string, until?: Date } = {}): Promise<Result<{ user: ManagedUser }, AdminChangeFailure | 'self' | 'admin' | 'until'>> {
    return (await load.admin()).banUser(this.state, userId, options)
  }

  async unban(userId: string): Promise<Result<{ user: ManagedUser }, AdminChangeFailure>> {
    return (await load.admin()).unbanUser(this.state, userId)
  }

  // Deletes a user with everything kayjs-auth keeps for them, calling `onDelete` and mailing them the account-deleted notice; oneself and another admin are refused.
  async deleteUser(userId: string): Promise<Result<object, AdminChangeFailure | 'self' | 'admin' | 'refused'>> {
    return (await load.admin()).deleteUser(this.state, userId)
  }

  // Everyone's audit log, or `userId`'s, newest first.
  async listAuditLog(query: { userId?: string, before?: AuditCursorInput, limit?: number } = {}): Promise<Result<{ entries: AuditEntry[] }, 'forbidden' | 'two-factor-required'>> {
    return (await load.admin()).adminAuditLog(this.state, query)
  }

  // Signs this browser in as `userId`, the admin's own sign-in kept for `admin.stopImpersonating`; 'stale' unless the admin signed in or re-proved lately. Nothing that takes a proof works meanwhile, and another admin cannot be impersonated.
  async impersonate(userId: string): Promise<Result<object, AdminFailure | 'stale' | 'self' | 'admin' | 'banned'>> {
    return (await load.admin()).impersonate(this.state, userId)
  }

  // Signs the admin back in as themselves; signed out when their own sign-in ended meanwhile. False when not impersonating.
  async stopImpersonating(): Promise<boolean> {
    return (await load.admin()).stopImpersonating(this.state)
  }
}
