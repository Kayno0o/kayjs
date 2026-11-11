import type { Core } from './core'
import type { AuthFailed } from './failure'
import type { OrganizationsCore } from './organizationsCore'
import type { RequestState } from './state'
import type { AuthStore, InvitationRecord, MaybePromise, MemberRecord, OrganizationRecord, UserRecord } from './store'
import { configError } from 'kay/library'
import { publicUser } from './core'
import { impersonatorOf, report } from './events'
import { failed } from './failure'
import { spend, typedKey } from './limits'
import { log } from './log'
import { writing } from './mail'
import { emailProblem, normalizeEmail } from './rules'
import { organizationsById, usersById } from './storeHelpers'

const NAME_MAX_LENGTH = 100
// Control characters, line and paragraph separators, and the marks that turn text around.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SLUG_MAX_LENGTH = 64

export interface Organization {
  id: string
  name: string
  slug: string | null
  createdAt: Date
}

// An organization the user belongs to, with their roles there.
export interface Membership<Role extends string = string> {
  organization: Organization
  roles: Role[]
  joinedAt: Date
}

export interface AuthMember<Role extends string = string> {
  user: { id: string, email: string | null, username: string | null }
  roles: Role[]
  joinedAt: Date
}

export interface Invitation<Role extends string = string> {
  id: string
  organization: Organization
  email: string
  roles: Role[]
  invitedBy: string | null
  createdAt: Date
  expiresAt: Date
}

// `not-found` for an organization the user is no member of, so its existence does not leak; `forbidden` for a member whose roles do not reach.
export type OrganizationFailure = 'signed-out' | 'not-found' | 'forbidden'

// A write adds `impersonating`: an admin acting as the user changes nothing about their organizations.
export type OrganizationWriteFailure = OrganizationFailure | 'impersonating'

export type CreateOrganizationResult<Role extends string = string> = { ok: true, membership: Membership<Role> } | AuthFailed<'signed-out' | 'impersonating' | 'forbidden' | 'invalid-name' | 'invalid-slug' | 'slug-taken' | 'limited'>

export type UpdateOrganizationResult = { ok: true, organization: Organization } | AuthFailed<OrganizationWriteFailure | 'invalid-name' | 'invalid-slug' | 'slug-taken'>

// `last-owner` keeps an organization from being left without one.
export type MemberResult = { ok: true } | AuthFailed<OrganizationWriteFailure | 'unknown-role' | 'last-owner'>

export type InviteResult<Role extends string = string> = { ok: true, invitation: Invitation<Role> } | AuthFailed<OrganizationWriteFailure | 'unverified' | 'unknown-role' | 'invalid-email' | 'member' | 'limited' | 'unavailable'>

export type ListMembersResult<Role extends string = string> = { ok: true, members: AuthMember<Role>[] } | AuthFailed<OrganizationFailure>

export type ListInvitationsResult<Role extends string = string> = { ok: true, invitations: Invitation<Role>[] } | AuthFailed<OrganizationFailure>

// `wrong-account` when the signed-in user's address is not the one invited, `unverified` while it is but unproven.
export type AcceptResult<Role extends string = string> = { ok: true, membership: Membership<Role> } | AuthFailed<'signed-out' | 'impersonating' | 'not-found' | 'wrong-account' | 'unverified' | 'member'>

interface Found { ok: true, record: UserRecord, organization: OrganizationRecord, member: MemberRecord }

interface Stores {
  organizations: NonNullable<AuthStore['organizations']>
  members: NonNullable<AuthStore['members']>
  invitations: NonNullable<AuthStore['invitations']>
}

export function organizationsOf(core: Core): { config: OrganizationsCore, store: Stores } {
  const { organizations: config } = core
  const { organizations, members, invitations } = core.store

  if (!config)
    throw configError('auth', 'organizations', 'organizations need the `organizations` option')

  if (!organizations || !members || !invitations)
    throw configError('auth', 'organizations', 'the `organizations` option needs a store keeping organizations, members and invitations, as memoryAuth and pgAuth do')

  return { config, store: { organizations, members, invitations } }
}

// By id, or by slug.
export async function findOrganization(core: Core, ref: string): Promise<OrganizationRecord | undefined> {
  const { store } = organizationsOf(core)

  return await store.organizations.get(ref) ?? await store.organizations.findBySlug(ref.toLowerCase())
}

// Whether the user is a member of the organization `ref` names, holding `role` there when given.
export async function holdsInOrganization(core: Core, userId: string, ref: string, role?: string): Promise<boolean> {
  const { config, store } = organizationsOf(core)
  const organization = await findOrganization(core, ref)
  const member = organization && await store.members.get(organization.id, userId)

  return member !== undefined && (role === undefined || config.isGranted(role, member.roles))
}

export async function createOrganization(state: RequestState, input: { name: string, slug?: string | null | undefined }): Promise<CreateOrganizationResult> {
  const { config, store } = organizationsOf(state.core)
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return failed('signed-out')

  if (await impersonatorOf(state) !== undefined)
    return failed('impersonating')

  if (config.create && !(await config.create(publicUser(record))))
    return failed('forbidden')

  if (await spend(state.core.rates, `organization:${record.id}`, state.core.limits.organization))
    return failed('limited')

  const name = input.name.trim()
  const slug = slugOf(input.slug)

  if (!validName(name))
    return failed('invalid-name')

  if (slug !== null && !validSlug(slug))
    return failed('invalid-slug')

  if (slug !== null && await store.organizations.findBySlug(slug))
    return failed('slug-taken')

  const organization: OrganizationRecord = { id: crypto.randomUUID(), name, slug, createdAt: new Date() }
  const member: MemberRecord = { organizationId: organization.id, userId: record.id, roles: [config.owner], createdAt: organization.createdAt }

  try {
    await store.organizations.create(organization)
  }
  // Taken between the check and the write.
  catch {
    return failed('slug-taken')
  }

  await store.members.add(member)
  await report(state, record, 'organization-created', organization.id)

  return { ok: true, membership: membership(organization, member) }
}

// Every organization the signed-in user belongs to, oldest joined first.
export async function listMemberships(state: RequestState): Promise<Membership[]> {
  const { store } = organizationsOf(state.core)
  const record = await state.current()

  if (!record)
    return []

  const memberships: Membership[] = []
  const held = await store.members.listByUser(record.id)
  const organizations = await organizationsById(store.organizations, held.map(member => member.organizationId))

  for (const member of held) {
    const organization = organizations.get(member.organizationId)

    if (organization)
      memberships.push(membership(organization, member))
  }

  return memberships
}

// The organization `ref` names, by id or slug, with the signed-in user's roles there; null unless they are a member.
export async function getMembership(state: RequestState, ref: string): Promise<Membership | null> {
  const found = await asMember(state, ref)

  return found.ok ? membership(found.organization, found.member) : null
}

export async function updateOrganization(state: RequestState, ref: string, patch: { name?: string | undefined, slug?: string | null | undefined }): Promise<UpdateOrganizationResult> {
  const { config, store } = organizationsOf(state.core)
  const found = await asMember(state, ref, config.manage, 'write')

  if (!found.ok)
    return found

  const name = patch.name?.trim()
  const slug = patch.slug === undefined ? undefined : slugOf(patch.slug)

  if (name !== undefined && !validName(name))
    return failed('invalid-name')

  if (slug != null && !validSlug(slug))
    return failed('invalid-slug')

  if (slug != null && slug !== found.organization.slug && await store.organizations.findBySlug(slug))
    return failed('slug-taken')

  let updated: OrganizationRecord | undefined

  try {
    updated = await store.organizations.update(found.organization.id, { ...name === undefined ? {} : { name }, ...slug === undefined ? {} : { slug } })
  }
  catch (error) {
    // Only a slug another organization took meanwhile is a conflict, any other failure is the store's.
    const holder = slug == null ? undefined : await store.organizations.findBySlug(slug)

    if (holder && holder.id !== found.organization.id)
      return failed('slug-taken')

    throw error
  }

  return updated ? { ok: true, organization: publicOrganization(updated) } : failed('not-found')
}

export type DeleteOrganizationResult = { ok: true } | AuthFailed<OrganizationWriteFailure>

// Owners only, from a session: every membership and invitation goes with it.
export async function deleteOrganization(state: RequestState, ref: string): Promise<DeleteOrganizationResult> {
  const { config, store } = organizationsOf(state.core)
  const found = await asMember(state, ref, config.owner, 'write')

  if (!found.ok)
    return found

  await store.organizations.delete(found.organization.id)
  await report(state, found.record, 'organization-deleted', found.organization.id)

  return { ok: true }
}

// Any member may list the others; only one who manages members is given their emails, the others' `email` is null (their own stays).
export async function listMembers(state: RequestState, ref: string): Promise<ListMembersResult> {
  const { config, store } = organizationsOf(state.core)
  const found = await asMember(state, ref)

  if (!found.ok)
    return found

  const members: AuthMember[] = []
  const managing = config.isGranted(config.manage, found.member.roles)

  const held = await store.members.listByOrganization(found.organization.id)
  const users = await usersById(state.core.store, held.map(member => member.userId))

  for (const member of held) {
    const user = users.get(member.userId)

    if (user)
      members.push({ user: { id: user.id, email: managing || user.id === found.record.id ? user.email : null, username: user.username }, roles: [...member.roles], joinedAt: member.createdAt })
  }

  return { ok: true, members }
}

// From a session only. A manager gives only roles they hold, to a member holding none above theirs: an admin cannot make an owner, nor demote one.
export async function setMemberRoles(state: RequestState, ref: string, userId: string, roles: string[]): Promise<MemberResult> {
  const { config, store } = organizationsOf(state.core)
  const found = await asMember(state, ref, config.manage, 'write')

  if (!found.ok)
    return found

  if (roles.some(role => !config.roles.has(role)))
    return failed('unknown-role')

  const target = await store.members.get(found.organization.id, userId)

  if (!target)
    return failed('not-found')

  if (!reaches(config, found.member.roles, [...target.roles, ...roles]))
    return failed('forbidden')

  if (target.roles.includes(config.owner) && !roles.includes(config.owner) && await lastOwner(config, store, found.organization.id))
    return failed('last-owner')

  await store.members.update(found.organization.id, userId, { roles: [...new Set(roles)] })

  if (target.roles.includes(config.owner) && !roles.includes(config.owner) && !await ownerKept(config, store, found.organization.id, async () => store.members.update(found.organization.id, userId, { roles: target.roles })))
    return failed('last-owner')

  await reportOn(state, userId, 'member-roles-changed', `${found.organization.id} ${roles.join(' ')}`, found.record)

  return { ok: true }
}

// From a session only: the signed-in user leaves, or a manager removes a member holding no role above theirs.
export async function removeMember(state: RequestState, ref: string, userId: string): Promise<MemberResult> {
  const { config, store } = organizationsOf(state.core)
  const self = (await state.current())?.id === userId
  const found = await asMember(state, ref, self ? undefined : config.manage, 'write')

  if (!found.ok)
    return found

  const target = self ? found.member : await store.members.get(found.organization.id, userId)

  if (!target)
    return failed('not-found')

  if (!self && !reaches(config, found.member.roles, target.roles))
    return failed('forbidden')

  if (target.roles.includes(config.owner) && await lastOwner(config, store, found.organization.id))
    return failed('last-owner')

  await store.members.delete(found.organization.id, userId)

  if (target.roles.includes(config.owner) && !await ownerKept(config, store, found.organization.id, async () => store.members.add(target)))
    return failed('last-owner')

  if (self)
    await report(state, found.record, 'member-left', found.organization.id)
  else
    await reportOn(state, userId, 'member-removed', found.organization.id, found.record)

  return { ok: true }
}

// The page an invitation link opens: the app's `invitationPage`, else the prebuilt pages' own, and none without either.
export function invitationPageOf(core: Core): string | undefined {
  return core.organizations?.invitationPage ?? (core.pages ? `${core.pages.prefix}/invitation` : undefined)
}

// Mails the address a link to the invitation page; an invitation the address already had is replaced.
export async function invite(state: RequestState, ref: string, email: string, roles?: string[]): Promise<InviteResult> {
  const { core } = state
  const { config, store } = organizationsOf(core)
  const found = await asMember(state, ref, config.manage, 'write')

  if (!found.ok)
    return found

  // The mail goes out from the site's domain in the inviter's words, the organization's name: only someone who proved an address of their own may send it.
  if (found.record.emailVerifiedAt === null)
    return failed('unverified')

  const given = roles ?? config.defaultRoles

  if (given.some(role => !config.roles.has(role)))
    return failed('unknown-role')

  if (!reaches(config, found.member.roles, given))
    return failed('forbidden')

  if (emailProblem(email))
    return failed('invalid-email')

  const mail = core.email

  const page = invitationPageOf(core)

  if (!mail || page === undefined)
    return failed('unavailable')

  const address = normalizeEmail(email)
  const invitee = await core.store.users.findByEmail(address)

  if (invitee && await store.members.get(found.organization.id, invitee.id))
    return failed('member')

  // Each mail goes to an inbox someone else owns, so neither a manager nor many managers together may flood it.
  if (await spend(core.rates, `invite:${found.record.id}`, core.limits.invite) || await spend(core.rates, typedKey(core, 'invite-address', address), core.limits.inviteAddress))
    return failed('limited')

  for (const earlier of await store.invitations.listByOrganization(found.organization.id)) {
    if (earlier.email === address)
      await store.invitations.delete(earlier.id)
  }

  const now = new Date()
  const invitation: InvitationRecord = { id: crypto.randomUUID(), organizationId: found.organization.id, email: address, roles: [...new Set(given)], invitedBy: found.record.id, createdAt: now, expiresAt: new Date(now.getTime() + config.invitationMaxAge * 1000) }

  await store.invitations.create(invitation)

  const url = `${core.url}${page}?invitation=${invitation.id}`
  const { locale, templates } = writing(mail, [invitee?.locale, found.record.locale, ...state.languages])

  try {
    await mail.mailer.send({ to: address, kind: 'invitation', name: core.name, detail: found.organization.name, locale, url, ...templates.invitation({ name: core.name, email: address, url, detail: found.organization.name, locale }) })
  }
  // Nobody would ever hear of an invitation left behind.
  catch (error) {
    log.error('mailing an invitation failed', error)
    await store.invitations.delete(invitation.id)

    return failed('unavailable')
  }

  return { ok: true, invitation: publicInvitation(invitation, found.organization) }
}

// The organization's invitations still open, oldest first, for its managers; expired ones are left out.
export async function listInvitations(state: RequestState, ref: string): Promise<ListInvitationsResult> {
  const { config, store } = organizationsOf(state.core)
  const found = await asMember(state, ref, config.manage, 'session')

  if (!found.ok)
    return found

  return { ok: true, invitations: (await standing(config, store, open(await store.invitations.listByOrganization(found.organization.id)))).map(invitation => publicInvitation(invitation, found.organization)) }
}

export type RevokeInvitationResult = { ok: true } | AuthFailed<OrganizationWriteFailure>

export async function revokeInvitation(state: RequestState, ref: string, invitationId: string): Promise<RevokeInvitationResult> {
  const { config, store } = organizationsOf(state.core)
  const found = await asMember(state, ref, config.manage, 'write')

  if (!found.ok)
    return found

  const invitation = await store.invitations.get(invitationId)

  if (invitation?.organizationId !== found.organization.id)
    return failed('not-found')

  await store.invitations.delete(invitation.id)

  return { ok: true }
}

// The invitations open to the signed-in user's verified address, oldest first.
export async function myInvitations(state: RequestState): Promise<Invitation[]> {
  const { config, store } = organizationsOf(state.core)
  const record = await state.current()

  if (record?.email == null || record.email === '' || record.emailVerifiedAt === null)
    return []

  const invitations: Invitation[] = []
  const pending = await standing(config, store, open(await store.invitations.listByEmail(record.email)))
  const organizations = await organizationsById(store.organizations, pending.map(invitation => invitation.organizationId))

  for (const invitation of pending) {
    const organization = organizations.get(invitation.organizationId)

    if (organization)
      invitations.push(publicInvitation(invitation, organization))
  }

  return invitations
}

// Every invitation that names the signed-in user: those to their address, expired ones included, and those they sent from the organizations they belong to.
export async function exportedInvitations(state: RequestState): Promise<{ received: Invitation[], sent: Invitation[] }> {
  const { store } = organizationsOf(state.core)
  const record = await state.current()
  const none = { received: [], sent: [] }

  if (!record)
    return none

  const received = record.email === null || record.email === '' ? [] : await store.invitations.listByEmail(record.email)
  const held = (await store.members.listByUser(record.id)).map(member => member.organizationId)
  const sent = (await Promise.all(held.map(async id => store.invitations.listByOrganization(id)))).flat().filter(invitation => invitation.invitedBy === record.id)
  const organizations = await organizationsById(store.organizations, [...new Set([...received, ...sent].map(invitation => invitation.organizationId))])
  const named = (invitations: InvitationRecord[]) => invitations.flatMap((invitation) => {
    const organization = organizations.get(invitation.organizationId)

    return organization ? [publicInvitation(invitation, organization)] : []
  })

  return { received: named(received), sent: named(sent) }
}

// What the link's page shows anyone holding it: which organization, for which address; null once revoked, spent or expired.
export async function getInvitation(state: RequestState, invitationId: string): Promise<Invitation | null> {
  const { config, store } = organizationsOf(state.core)
  const found = await live(store, invitationId)
  const invitation = found && await senderMay(config, store, found) ? found : undefined
  const organization = invitation && await store.organizations.get(invitation.organizationId)

  return invitation && organization ? publicInvitation(invitation, organization) : null
}

// Only an account verified at the invited address accepts, so a forwarded link is worth nothing to anyone else.
export async function acceptInvitation(state: RequestState, invitationId: string): Promise<AcceptResult> {
  const { config, store } = organizationsOf(state.core)
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return failed('signed-out')

  if (await impersonatorOf(state) !== undefined)
    return failed('impersonating')

  const found = await live(store, invitationId)
  const invitation = found && await senderMay(config, store, found) ? found : undefined
  const organization = invitation && await store.organizations.get(invitation.organizationId)

  if (!invitation || !organization)
    return failed('not-found')

  if (record.email !== invitation.email)
    return failed('wrong-account')

  if (record.emailVerifiedAt === null)
    return failed('unverified')

  if (await store.members.get(organization.id, record.id))
    return failed('member')

  // Deleted first, so of two requests accepting it only one adds the member.
  if (!(await store.invitations.delete(invitation.id)))
    return failed('not-found')

  const member: MemberRecord = { organizationId: organization.id, userId: record.id, roles: invitation.roles, createdAt: new Date() }

  await store.members.add(member)
  await report(state, record, 'member-joined', `${organization.id} ${member.roles.join(' ')}`)

  return { ok: true, membership: membership(organization, member) }
}

export type RejectInvitationResult = { ok: true } | AuthFailed<'signed-out' | 'impersonating' | 'not-found'>

// The invited user turns it down; `not-found` when it is not open to them, whoever it was meant for.
export async function declineInvitation(state: RequestState, invitationId: string): Promise<RejectInvitationResult> {
  const { store } = organizationsOf(state.core)
  const record = await state.current()

  if (!record || state.via() !== 'session')
    return failed('signed-out')

  if (await impersonatorOf(state) !== undefined)
    return failed('impersonating')

  const invitation = await live(store, invitationId)

  if (record.email == null || record.email === '' || record.emailVerifiedAt === null || invitation?.email !== record.email)
    return failed('not-found')

  return (await store.invitations.delete(invitation.id)) ? { ok: true } : failed('not-found')
}

// The signed-in user's membership of the organization `ref` names, holding `role` there when given; with `access`, a bearer or OAuth token is refused as signed out, and 'write' also refuses an admin acting as the user.
async function asMember(state: RequestState, ref: string, role: string | undefined, access: 'write'): Promise<Found | AuthFailed<OrganizationWriteFailure>>
async function asMember(state: RequestState, ref: string, role?: string, access?: 'session'): Promise<Found | AuthFailed<OrganizationFailure>>

async function asMember(state: RequestState, ref: string, role?: string, access?: 'session' | 'write'): Promise<Found | AuthFailed<OrganizationWriteFailure>> {
  const { config, store } = organizationsOf(state.core)
  const record = await state.current()

  if (!record || (access !== undefined && state.via() !== 'session'))
    return failed('signed-out')

  if (access === 'write' && await impersonatorOf(state) !== undefined)
    return failed('impersonating')

  const organization = await findOrganization(state.core, ref)
  const member = organization && await store.members.get(organization.id, record.id)

  if (!organization || !member)
    return failed('not-found')

  if (role !== undefined && !config.isGranted(role, member.roles))
    return failed('forbidden')

  return { ok: true, record, organization, member }
}

// Whether `held` includes every one of `roles`.
function reaches(config: OrganizationsCore, held: string[], roles: string[]): boolean {
  return roles.every(role => config.isGranted(role, held))
}

async function lastOwner(config: OrganizationsCore, store: Stores, organizationId: string, atMost = 1): Promise<boolean> {
  return (await store.members.listByOrganization(organizationId)).filter(member => member.roles.includes(config.owner)).length <= atMost
}

// Checked again after the write, as two requests can each see the other owner still there: when none is left, `restore` puts the member back, so of two racing the last owners at least one stays.
async function ownerKept(config: OrganizationsCore, store: Stores, organizationId: string, restore: () => Promise<unknown>): Promise<boolean> {
  if (!await lastOwner(config, store, organizationId, 0))
    return true

  // An organization deleted meanwhile has nothing to put the member back in.
  if (await store.organizations.get(organizationId)) {
    try {
      await restore()
    }
    catch (error) {
      // The member is back already, or gone with their account: nothing is left to undo. Otherwise the store failed and the organization has no owner, so the error is not hidden.
      if (await store.organizations.get(organizationId) && await lastOwner(config, store, organizationId, 0))
        throw error
    }
  }

  return false
}

async function live(store: Stores, invitationId: string): Promise<InvitationRecord | undefined> {
  const invitation = await store.invitations.get(invitationId)

  return invitation && invitation.expiresAt.getTime() > Date.now() ? invitation : undefined
}

// Whether a sender, as the member they are of the organization, still may grant the roles: they manage it and hold them.
function mayGrant(config: OrganizationsCore, sender: MemberRecord | undefined, roles: string[]): boolean {
  return sender !== undefined && config.isGranted(config.manage, sender.roles) && reaches(config, sender.roles, roles)
}

// Whether whoever sent the invitation still may grant what it gives. One whose sender is gone, their account deleted included, is dead.
async function senderMay(config: OrganizationsCore, store: Stores, invitation: InvitationRecord): Promise<boolean> {
  return mayGrant(config, invitation.invitedBy === null ? undefined : await store.members.get(invitation.organizationId, invitation.invitedBy), invitation.roles)
}

// The invitations whose sender still may grant them, each sender of an organization looked up once.
async function standing(config: OrganizationsCore, store: Stores, invitations: InvitationRecord[]): Promise<InvitationRecord[]> {
  const senders = new Map<string, MaybePromise<MemberRecord | undefined>>()
  const may = await Promise.all(invitations.map(async (invitation) => {
    if (invitation.invitedBy === null)
      return false

    const key = `${invitation.organizationId}\0${invitation.invitedBy}`
    const sender = senders.get(key) ?? store.members.get(invitation.organizationId, invitation.invitedBy)

    senders.set(key, sender)

    return mayGrant(config, await sender, invitation.roles)
  }))

  return invitations.filter((_invitation, index) => may[index])
}

// The invitations not yet expired; the store's pruning deletes the others.
function open(invitations: InvitationRecord[]): InvitationRecord[] {
  const now = Date.now()

  return invitations.filter(invitation => invitation.expiresAt.getTime() > now)
}

async function reportOn(state: RequestState, userId: string, event: 'member-roles-changed' | 'member-removed', detail: string, actor: UserRecord): Promise<void> {
  const record = await state.core.store.users.get(userId)

  if (record)
    await report(state, record, event, detail, actor)
}

// A slug as typed, trimmed and lowercased; none when left blank.
function slugOf(typed: string | null | undefined): string | null {
  const slug = typed?.trim().toLowerCase()

  return slug === undefined || slug === '' ? null : slug
}

// A name goes into the invitation mail's subject and lead, where a line break or a direction override would let it pass for something else.
function validName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX_LENGTH && !UNPRINTABLE.test(name)
}

function validSlug(slug: string): boolean {
  return slug.length <= SLUG_MAX_LENGTH && SLUG.test(slug)
}

function publicOrganization(record: OrganizationRecord): Organization {
  return { id: record.id, name: record.name, slug: record.slug, createdAt: record.createdAt }
}

function membership(organization: OrganizationRecord, member: MemberRecord): Membership {
  return { organization: publicOrganization(organization), roles: [...member.roles], joinedAt: member.createdAt }
}

function publicInvitation(invitation: InvitationRecord, organization: OrganizationRecord): Invitation {
  return { id: invitation.id, organization: publicOrganization(organization), email: invitation.email, roles: [...invitation.roles], invitedBy: invitation.invitedBy, createdAt: invitation.createdAt, expiresAt: invitation.expiresAt }
}

export type { OrganizationsCore, OrganizationsOptions } from './organizationsCore'
