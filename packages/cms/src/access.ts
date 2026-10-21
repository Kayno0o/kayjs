import type { GuardContext } from 'kay'
import type { Passwords } from './password'
import type { Action } from './roles'
import { localPath } from 'kay'
import { READ_METHODS } from 'kay/library'
import { wording } from 'kay/words'
import { activePasswords, SESSION_COOKIE, signedInBy } from './password'
import { screenPath } from './paths'
import { ACTIONS } from './roles'
import { settings } from './settings'

// The part of kayjs-auth's `ctx.locals.auth` the cms reads: found by its shape, so the cms works without it installed.
interface AuthLike {
  bareUser?: () => Promise<MemberLike | null>
  user?: () => Promise<MemberLike | null>
  isGranted?: (role: string, user: MemberLike) => boolean
  signInUrl?: (back?: string) => string
  signOut?: () => Promise<void>
}

interface MemberLike {
  id?: unknown
  email?: unknown
  username?: unknown
  roles?: unknown
}

export interface Member {
  // What the admin calls the person: a username, else an email, else the role a password opened.
  name: string
  // The names `cms({ roles })` lists that the person holds.
  held: string[]
}

// A refusal a guard threw (`ctx.deny`, `ctx.redirect`) rather than a fault, found by its status as kay does not export the classes.
export function refusalStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || error instanceof Error)
    return undefined

  const { status } = error as { status?: unknown }

  return typeof status === 'number' ? status : undefined
}

function authOf(ctx: GuardContext): AuthLike | undefined {
  const auth = (ctx.locals as { auth?: unknown } | undefined)?.auth

  return typeof auth === 'object' && auth !== null && (typeof (auth as AuthLike).bareUser === 'function' || typeof (auth as AuthLike).user === 'function') ? auth : undefined
}

const REPEATED_SLASHES = /\/{2,}/g

// The name of each action in a refusal.
const ACTION_NAMES: Record<Action, () => string> = {
  publish: () => wording('cms.role.publish', 'publish or unpublish'),
  delete: () => wording('cms.role.delete', 'delete'),
  upload: () => wording('cms.role.upload', 'upload a file'),
  redirects: () => wording('cms.role.redirects', 'change redirects'),
}

const members = new WeakMap<Request, Promise<Member | undefined>>()

// Who is signed in on this request, from the password guard when it let the request in, else from kayjs-auth's session; read once per request.
export async function memberOf(ctx: GuardContext): Promise<Member | undefined> {
  const cached = members.get(ctx.request)

  if (cached)
    return cached

  const found = readMember(ctx)

  members.set(ctx.request, found)

  return found
}

async function readMember(ctx: GuardContext): Promise<Member | undefined> {
  const password = signedInBy.get(ctx.request)

  if (password)
    return { name: password.name, held: [...password.roles] }

  const { member, roles } = settings()

  if (member) {
    const given = await member(ctx)

    return given && { name: given.name ?? '', held: [...roles?.keys() ?? []].filter(role => given.roles.includes(role)) }
  }

  const auth = authOf(ctx)
  const user = await (auth?.bareUser ?? auth?.user)?.call(auth)

  if (!auth || !user)
    return undefined

  const owned = Array.isArray(user.roles) ? user.roles.filter(role => typeof role === 'string') : []
  const held = [...roles?.keys() ?? []].filter(role => auth.isGranted ? auth.isGranted(role, user) : owned.includes(role))
  const name = [user.username, user.email, user.id].find(value => (typeof value === 'string' && value !== '') || typeof value === 'number')

  return { name: String(name ?? ''), held }
}

// The actions the signed-in person may not do, each with the reason a disabled control gives; empty when the app lists no roles.
export type Denials = Partial<Record<Action, string>>

function deniedTo(member: Member | undefined): Denials {
  const { roles } = settings()
  const found: Denials = {}

  if (roles === undefined)
    return found

  for (const action of ACTIONS) {
    if (!member?.held.some(role => roles.get(role)?.has(action)))
      found[action] = refusal(action)
  }

  return found
}

export async function denials(ctx: GuardContext): Promise<Denials> {
  return deniedTo(settings().roles === undefined ? undefined : await memberOf(ctx))
}

// The same for a request the api guard has read the person of (it does for every request when the app lists roles), as an API route has no guard context.
export async function denialsOf(request: Request): Promise<Denials> {
  return deniedTo(await members.get(request))
}

function refusal(action: Action): string {
  return wording('cms.guard.forbidden', 'Your role may not do this: {action}', { action: ACTION_NAMES[action]() })
}

// Whether the signed-in person may do an action: everyone the guard admits may when the app lists no roles, and nobody may when it lists some and none of the person's roles allows it.
export async function may(ctx: GuardContext, action: Action): Promise<boolean> {
  const { roles } = settings()

  if (roles === undefined)
    return true

  const member = await memberOf(ctx)

  return member?.held.some(role => roles.get(role)?.has(action)) ?? false
}

export function forbidden(ctx: GuardContext, action: Action): never {
  return ctx.deny(403, refusal(action))
}

// Where an anonymous visitor goes to sign in and return to `back`: the cms's own screen for a password guard, else kayjs-auth's sign-in page, else nowhere.
export function signInTarget(ctx: GuardContext, back: string): string | undefined {
  if (activePasswords())
    return `${screenPath(settings().prefix, '/sign-in')}?redirect=${encodeURIComponent(back)}`

  try {
    return authOf(ctx)?.signInUrl?.(back)
  }
  catch {
    // kayjs-auth names no sign-in page.
    return undefined
  }
}

// The path and query of the page asked for, which a hostile value cannot turn into another site.
export function backTo(ctx: GuardContext): string {
  return localPath(ctx.url.pathname + ctx.url.search, '/')
}

// Sends a visitor the guard turned away as anonymous to sign in, returning to this page afterwards; any other refusal stays as it was. Only a read goes: a post has no page to return to.
export function sendToSignIn(ctx: GuardContext, error: unknown): void {
  const target = refusalStatus(error) === 401 && READ_METHODS.has(ctx.request.method) ? signInTarget(ctx, backTo(ctx)) : undefined

  if (target !== undefined)
    ctx.redirect(target)
}

// Ends the sign-in: a password guard's cookie, else kayjs-auth's session.
export async function signOutOf(ctx: GuardContext): Promise<void> {
  activePasswords()?.revoke(ctx.cookies.get(SESSION_COOKIE))
  ctx.cookies.delete({ name: SESSION_COOKIE, path: '/' })
  await authOf(ctx)?.signOut?.()
}

// The path without query, doubled or trailing slashes, as the router matches it.
export function routePath(url: URL): string {
  const path = url.pathname.replace(REPEATED_SLASHES, '/')

  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

// Runs the app's guard to load it, as its first request may be the sign-in screen's, and says whether it let the request in and which passwords it holds. A refusal is an answer here; a fault is not.
export async function probe(ctx: GuardContext): Promise<{ signedIn: boolean, passwords: Passwords | undefined }> {
  let signedIn = true

  try {
    await settings().guard?.(ctx)
  }
  catch (error) {
    if (refusalStatus(error) === undefined)
      throw error

    signedIn = false
  }

  return { signedIn: signedIn && settings().guard !== undefined, passwords: activePasswords() }
}
