import type { Result } from '../failure'
import type { AuthMember, Invitation, Membership, Organization, OrganizationFailure, OrganizationWriteFailure } from '../organizations'
import type { RequestState } from '../state'
import { failed } from '../failure'
import { load } from '../load'

// `auth.organizations`: the teams or workspaces of the `organizations` option, each named by `ref`, its id or slug.
export class OrganizationMethods<OrgRole extends string = string> {
  constructor(private readonly state: RequestState) {}

  // A new organization, the signed-in user its owner. `slug`, lowercase letters, digits and dashes, names it in URLs.
  async create(input: { name: string, slug?: string | null | undefined }): Promise<Result<{ membership: Membership<OrgRole> }, 'signed-out' | 'impersonating' | 'forbidden' | 'invalid-name' | 'invalid-slug' | 'slug-taken' | 'limited'>> {
    return (await load.organizations()).createOrganization(this.state, input) as Promise<Result<{ membership: Membership<OrgRole> }, 'signed-out' | 'impersonating' | 'forbidden' | 'invalid-name' | 'invalid-slug' | 'slug-taken' | 'limited'>>
  }

  // The organizations the signed-in user belongs to, with their roles in each.
  async list(): Promise<Membership<OrgRole>[]> {
    return (await load.organizations()).listMemberships(this.state) as Promise<Membership<OrgRole>[]>
  }

  // The organization `ref` names, with the user's roles there; null unless they are a member.
  async get(ref: string): Promise<Membership<OrgRole> | null> {
    return (await load.organizations()).getMembership(this.state, ref) as Promise<Membership<OrgRole> | null>
  }

  // Whether the user is a member of the organization `ref` names, holding `role` there when given.
  async isMember(ref: string, role?: OrgRole): Promise<boolean> {
    const record = await this.state.current()

    return record !== null && (await load.organizations()).holdsInOrganization(this.state.core, record.id, ref, role)
  }

  // Renames it, or changes or clears its slug: for members holding `manage`.
  async update(ref: string, patch: { name?: string | undefined, slug?: string | null | undefined }): Promise<Result<{ organization: Organization }, OrganizationWriteFailure | 'invalid-name' | 'invalid-slug' | 'slug-taken'>> {
    return (await load.organizations()).updateOrganization(this.state, ref, patch)
  }

  // For members holding `owner`.
  async delete(ref: string): Promise<Result<object, OrganizationWriteFailure>> {
    return (await load.organizations()).deleteOrganization(this.state, ref)
  }

  // Every member, oldest first, for any member to see.
  async listMembers(ref: string): Promise<Result<{ members: AuthMember<OrgRole>[] }, OrganizationFailure>> {
    return (await load.organizations()).listMembers(this.state, ref) as Promise<Result<{ members: AuthMember<OrgRole>[] }, OrganizationFailure>>
  }

  // Replaces a member's roles: for members holding `manage`, giving only roles they hold, to a member holding none above theirs.
  async updateMemberRoles(ref: string, userId: string, roles: OrgRole[]): Promise<Result<object, OrganizationWriteFailure | 'unknown-role' | 'last-owner'>> {
    return (await load.organizations()).setMemberRoles(this.state, ref, userId, roles)
  }

  // For members holding `manage`, of a member holding no role above theirs.
  async deleteMember(ref: string, userId: string): Promise<Result<object, OrganizationWriteFailure | 'unknown-role' | 'last-owner'>> {
    return (await load.organizations()).removeMember(this.state, ref, userId)
  }

  async leave(ref: string): Promise<Result<object, OrganizationWriteFailure | 'unknown-role' | 'last-owner'>> {
    const record = await this.state.current()

    return record ? (await load.organizations()).removeMember(this.state, ref, record.id) : failed('signed-out')
  }

  // Mails `email` a link to the `invitationPage`, else the prebuilt pages' invitation page, giving `roles` (`defaultRoles` when none) once accepted: for members holding `manage` and every role it gives.
  async invite(ref: string, email: string, roles?: OrgRole[]): Promise<Result<{ invitation: Invitation<OrgRole> }, OrganizationWriteFailure | 'unverified' | 'unknown-role' | 'invalid-email' | 'member' | 'limited' | 'unavailable'>> {
    return (await load.organizations()).invite(this.state, ref, email, roles) as Promise<Result<{ invitation: Invitation<OrgRole> }, OrganizationWriteFailure | 'unverified' | 'unknown-role' | 'invalid-email' | 'member' | 'limited' | 'unavailable'>>
  }

  // The organization's open invitations, for members holding `manage`.
  async listInvitations(ref: string): Promise<Result<{ invitations: Invitation<OrgRole>[] }, OrganizationFailure>> {
    return (await load.organizations()).listInvitations(this.state, ref) as Promise<Result<{ invitations: Invitation<OrgRole>[] }, OrganizationFailure>>
  }

  async revokeInvitation(ref: string, invitationId: string): Promise<Result<object, OrganizationWriteFailure>> {
    return (await load.organizations()).revokeInvitation(this.state, ref, invitationId)
  }

  // The invitations open to the signed-in user's verified address.
  async listMyInvitations(): Promise<Invitation<OrgRole>[]> {
    return (await load.organizations()).myInvitations(this.state) as Promise<Invitation<OrgRole>[]>
  }

  // What the invitation link's page shows; null once revoked, accepted or expired.
  async getInvitation(invitationId: string): Promise<Invitation<OrgRole> | null> {
    return (await load.organizations()).getInvitation(this.state, invitationId) as Promise<Invitation<OrgRole> | null>
  }

  // For an account verified at the invited address only.
  async acceptInvitation(invitationId: string): Promise<Result<{ membership: Membership<OrgRole> }, 'signed-out' | 'impersonating' | 'not-found' | 'wrong-account' | 'unverified' | 'member'>> {
    return (await load.organizations()).acceptInvitation(this.state, invitationId) as Promise<Result<{ membership: Membership<OrgRole> }, 'signed-out' | 'impersonating' | 'not-found' | 'wrong-account' | 'unverified' | 'member'>>
  }

  // Turns down an invitation open to the user; `not-found` for any other.
  async rejectInvitation(invitationId: string): Promise<Result<object, 'signed-out' | 'impersonating' | 'not-found'>> {
    return (await load.organizations()).declineInvitation(this.state, invitationId)
  }
}
