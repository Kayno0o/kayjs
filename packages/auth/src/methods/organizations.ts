import type { AcceptResult, CreateOrganizationResult, DeleteOrganizationResult, Invitation, InviteResult, ListInvitationsResult, ListMembersResult, MemberResult, Membership, RejectInvitationResult, RevokeInvitationResult, UpdateOrganizationResult } from '../organizations'
import type { RequestState } from '../state'
import { load } from '../load'

// `auth.organizations`: the teams or workspaces of the `organizations` option, each named by `ref`, its id or slug.
export class OrganizationMethods<OrgRole extends string = string> {
  constructor(private readonly state: RequestState) {}

  // A new organization, the signed-in user its owner. `slug`, lowercase letters, digits and dashes, names it in URLs.
  async create(input: { name: string, slug?: string | null | undefined }): Promise<CreateOrganizationResult<OrgRole>> {
    return (await load.organizations()).createOrganization(this.state, input) as Promise<CreateOrganizationResult<OrgRole>>
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
  async update(ref: string, patch: { name?: string | undefined, slug?: string | null | undefined }): Promise<UpdateOrganizationResult> {
    return (await load.organizations()).updateOrganization(this.state, ref, patch)
  }

  // For members holding `owner`.
  async delete(ref: string): Promise<DeleteOrganizationResult> {
    return (await load.organizations()).deleteOrganization(this.state, ref)
  }

  // Every member, oldest first, for any member to see.
  async members(ref: string): Promise<ListMembersResult<OrgRole>> {
    return (await load.organizations()).listMembers(this.state, ref) as Promise<ListMembersResult<OrgRole>>
  }

  // Replaces a member's roles: for members holding `manage`, giving only roles they hold, to a member holding none above theirs.
  async setMemberRoles(ref: string, userId: string, roles: OrgRole[]): Promise<MemberResult> {
    return (await load.organizations()).setMemberRoles(this.state, ref, userId, roles)
  }

  // For members holding `manage`, of a member holding no role above theirs.
  async removeMember(ref: string, userId: string): Promise<MemberResult> {
    return (await load.organizations()).removeMember(this.state, ref, userId)
  }

  async leave(ref: string): Promise<MemberResult> {
    const record = await this.state.current()

    return record ? (await load.organizations()).removeMember(this.state, ref, record.id) : { ok: false, error: 'signed-out' }
  }

  // Mails `email` a link to the `invitationPage`, else the prebuilt pages' invitation page, giving `roles` (`defaultRoles` when none) once accepted: for members holding `manage` and every role it gives.
  async invite(ref: string, email: string, roles?: OrgRole[]): Promise<InviteResult<OrgRole>> {
    return (await load.organizations()).invite(this.state, ref, email, roles) as Promise<InviteResult<OrgRole>>
  }

  // The organization's open invitations, for members holding `manage`.
  async invitations(ref: string): Promise<ListInvitationsResult<OrgRole>> {
    return (await load.organizations()).listInvitations(this.state, ref) as Promise<ListInvitationsResult<OrgRole>>
  }

  async revokeInvitation(ref: string, invitationId: string): Promise<RevokeInvitationResult> {
    return (await load.organizations()).revokeInvitation(this.state, ref, invitationId)
  }

  // The invitations open to the signed-in user's verified address.
  async myInvitations(): Promise<Invitation<OrgRole>[]> {
    return (await load.organizations()).myInvitations(this.state) as Promise<Invitation<OrgRole>[]>
  }

  // What the invitation link's page shows; null once revoked, accepted or expired.
  async invitation(invitationId: string): Promise<Invitation<OrgRole> | null> {
    return (await load.organizations()).getInvitation(this.state, invitationId) as Promise<Invitation<OrgRole> | null>
  }

  // For an account verified at the invited address only.
  async acceptInvitation(invitationId: string): Promise<AcceptResult<OrgRole>> {
    return (await load.organizations()).acceptInvitation(this.state, invitationId) as Promise<AcceptResult<OrgRole>>
  }

  // Turns down an invitation open to the user; `not-found` for any other.
  async rejectInvitation(invitationId: string): Promise<RejectInvitationResult> {
    return (await load.organizations()).declineInvitation(this.state, invitationId)
  }
}
