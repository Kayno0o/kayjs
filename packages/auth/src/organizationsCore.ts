import type { Duration } from 'kay'
import type { Access } from './access'
import type { BareUser } from './core'
import type { Requirement } from './types'
import { durationSeconds } from 'kay/library'
import { createRoleHierarchy } from './roles'

const DEFAULT_INVITATION_MAX_AGE = '7d'

export interface OrganizationsOptions<OrgRole extends string, Role extends string> {
  // Each organization role and the roles it includes, as `roles` is for the site: `{ owner: ['admin'], admin: ['member'], member: [] }`.
  roles: Record<OrgRole, NoInfer<OrgRole>[]>
  // The role of whoever creates an organization: one holding it may delete it, and the last member holding it cannot leave or lose it.
  owner: NoInfer<OrgRole>
  // What a member needs to rename the organization, invite, remove members and change their roles; `owner` by default.
  manage?: NoInfer<OrgRole> | undefined
  // What an invitation naming no roles gives, such as `['member']`; none by default, a plain membership.
  defaultRoles?: NoInfer<OrgRole>[] | undefined
  // Who may create an organization, a site role or a predicate; anyone signed in by default.
  create?: Requirement<BareUser, NoInfer<Role>> | undefined
  // The app's page an invitation link opens, the invitation's id in `?invitation=`: it shows `organizations.invitation(id)` and accepts it. The prebuilt pages' own `/auth/invitation` by default; inviting answers 'unavailable' without either.
  invitationPage?: string | undefined
  // How long an invitation lasts, `invitations: { maxAge: '7d' }`, a week by default.
  invitations?: { maxAge?: Duration | undefined } | undefined
  // The route param naming the organization a route is about, by id or slug, for `memberOf`: `org` by default.
  param?: string | undefined
}

// What the `organizations` option settles, as kayjs-auth works with it.
export interface OrganizationsCore {
  roles: Set<string>
  // Whether `held` includes `required`, through the hierarchy.
  isGranted: (required: string, held: string[]) => boolean
  owner: string
  manage: string
  defaultRoles: string[]
  param: string
  invitationPage?: string | undefined
  invitationMaxAge: number
  // Whether a user may create an organization; anyone signed in without it.
  create?: ((user: BareUser) => Promise<boolean>) | undefined
}

// `create` asks the app's `authorize`, through `access`.
export function organizationsCore<OrgRole extends string, Role extends string>(options: OrganizationsOptions<OrgRole, Role>, access: Access<Role>): OrganizationsCore {
  const { isGranted } = createRoleHierarchy<BareUser, OrgRole>(options.roles, user => user.roles as OrgRole[])
  const create = options.create

  return {
    ...create !== undefined && { create: async user => access.authorize(user, create, 'write', {}) },
    roles: new Set(Object.keys(options.roles)),
    isGranted: (required, held) => isGranted(required, held),
    owner: options.owner,
    manage: options.manage ?? options.owner,
    defaultRoles: [...options.defaultRoles ?? []],
    param: options.param ?? 'org',
    invitationPage: options.invitationPage,
    invitationMaxAge: durationSeconds(options.invitations?.maxAge ?? DEFAULT_INVITATION_MAX_AGE, 'organizations.invitations.maxAge'),
  }
}
