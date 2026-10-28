import type { Guard, GuardContext } from 'kay'
import { log } from './log'

// Set by a kayjs-auth whose `requireUser()` reads `require`; an older one ignores it and would admit every signed-in user.
const REQUIRES = Symbol.for('kayjs-auth.requires')

// The part of kayjs-auth's `ctx.locals.auth` the cms reads: found by its shape, so the cms works without it installed.
interface AuthLike {
  bareUser?: () => Promise<MemberLike | null>
  user?: () => Promise<MemberLike | null>
  isGranted?: (role: string, user: MemberLike) => boolean
  organizations?: OrganizationsLike
  userIdsHolding?: (role: string) => Promise<string[]>
  signInUrl?: (back?: string) => string
  signOut?: () => Promise<void>
  requireUser?: (options: { require: string, bare: true }) => Promise<unknown>
  [REQUIRES]?: unknown
}

// `auth.organizations`, the methods of kayjs-auth's `organizations` option.
interface OrganizationsLike {
  list?: () => Promise<MembershipLike[]>
  isMember?: (organization: string, role?: string) => Promise<boolean>
  members?: (organization: string) => Promise<{ ok: true, members: { user: { id: unknown }, roles: readonly string[] }[] } | { ok: false }>
}

interface MemberLike {
  id?: unknown
  email?: unknown
  username?: unknown
  roles?: unknown
}

export function authOf(ctx: GuardContext): AuthLike | undefined {
  const auth = (ctx.locals as { auth?: unknown } | undefined)?.auth

  return typeof auth === 'object' && auth !== null && (typeof (auth as AuthLike).bareUser === 'function' || typeof (auth as AuthLike).user === 'function') ? auth : undefined
}

let unauthed = false

// What `cms({ role })` guards with: kayjs-auth's `requireUser({ require: role })`, so the app's `authorize` decides as in `auth.guard()`; a request with no kayjs-auth in its locals is refused, never let through.
export function roleGuard(role: string): Guard {
  return async (ctx) => {
    const auth = authOf(ctx)

    if (typeof auth?.requireUser !== 'function' || auth[REQUIRES] !== true) {
      if (!unauthed) {
        unauthed = true
        log.error(`cms({ role: '${role}' }) found no kayjs-auth of this release on the request, so it refuses every editor: list auth() in the extensions of kay.config.ts at the cms's version, or give cms({ guard }) instead`)
      }

      return ctx.deny(403)
    }

    await auth.requireUser({ require: role, bare: true })
  }
}

// The part of a kayjs-auth organization membership the cms reads.
export interface MembershipLike {
  organization: { id: string, slug?: string | null }
  roles: readonly string[]
}

// A key of `cms({ roles })` naming a role held in a kayjs-auth organization: `org:<role>` in any of the person's organizations, `org:<organization>:<role>` in that one (its id or slug).
const ORGANIZATION_ROLE = /^org:(?:([^:]+):)?([^:]+)$/

export function isOrganizationRole(key: string): boolean {
  return ORGANIZATION_ROLE.test(key)
}

export function organizationRole(key: string): { organization: string | undefined, role: string } | undefined {
  const [, organization, role] = ORGANIZATION_ROLE.exec(key) ?? []

  return role === undefined ? undefined : { organization, role }
}

const inOrganization = (membership: MembershipLike, organization: string) => membership.organization.id === organization || membership.organization.slug === organization

// The `org:` keys among `keys` the signed-in person holds, the organization's own hierarchy counting through `auth.organizations.isMember`.
export async function heldInOrganizations(auth: AuthLike, keys: readonly string[]): Promise<string[]> {
  const wanted = keys.filter(isOrganizationRole)

  const organizations = auth.organizations

  if (wanted.length === 0 || typeof organizations?.list !== 'function' || typeof organizations.isMember !== 'function')
    return []

  const memberships = await organizations.list()
  const held: string[] = []

  for (const key of wanted) {
    const { organization, role } = organizationRole(key)!

    for (const membership of memberships) {
      if ((organization === undefined || inOrganization(membership, organization)) && await organizations.isMember(membership.organization.id, role)) {
        held.push(key)

        break
      }
    }
  }

  return held
}

// The ids of the users holding one of the site roles `keys` names, a role above it in kayjs-auth's hierarchy counting, themselves left out. A kayjs-auth without `userIdsHolding` lists no one.
export async function siteRoleHolders(auth: AuthLike, keys: readonly string[], except: string | undefined): Promise<string[]> {
  if (typeof auth.userIdsHolding !== 'function')
    return []

  const found = new Set<string>()

  for (const key of keys.filter(key => !isOrganizationRole(key))) {
    for (const id of await auth.userIdsHolding(key))
      found.add(String(id))
  }

  found.delete(String(except))

  return [...found]
}

// The ids of the people who hold a role of `keys` in an organization of the signed-in person, themselves left out: whom a submission is told to. A member counts when they hold the role itself, as kayjs-auth does not tell a role's hierarchy.
export async function organizationMembers(auth: AuthLike, keys: readonly string[], except: string | undefined): Promise<string[]> {
  const wanted = keys.filter(isOrganizationRole)

  const organizations = auth.organizations

  if (wanted.length === 0 || typeof organizations?.list !== 'function' || typeof organizations.members !== 'function')
    return []

  const memberships = await organizations.list()
  const found = new Set<string>()

  for (const key of wanted) {
    const { organization, role } = organizationRole(key)!

    for (const membership of memberships) {
      if (organization !== undefined && !inOrganization(membership, organization))
        continue

      const listed = await organizations.members(membership.organization.id)

      for (const member of listed.ok ? listed.members : []) {
        if (member.roles.includes(role) && String(member.user.id) !== except)
          found.add(String(member.user.id))
      }
    }
  }

  return [...found]
}
