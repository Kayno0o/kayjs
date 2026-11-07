import type { GuardContext } from 'kay'
import type { Passwords } from './password'
import type { CmsAction, Role } from './roles'
import { localPath } from 'kay'
import { keyedDigest, READ_METHODS } from 'kay/library'
import { wording } from 'kay/words'
import { authOf, heldInOrganizations, isOrganizationRole } from './auth-like'
import { activePasswords, HOST_SESSION_COOKIE, SESSION_COOKIE, sessionCookiesOf, signedInBy } from './password'
import { screenPath } from './paths'
import { ACTIONS } from './roles'
import { settings } from './settings'

export interface Member {
  // The signed-in person's kayjs-auth id, which a notification is addressed to; none for a password or a custom guard.
  id?: string | undefined
  // What the admin calls the person: a username, else an email, else the role a password opened.
  name: string
  // The names `cms({ roles })` lists that the person holds.
  held: string[]
  // The signed-in person's email, when the guard knows it.
  email?: string | undefined
}

// A refusal a guard threw (`ctx.deny`, `ctx.redirect`) rather than a fault, found by its status as kay does not export the classes.
export function refusalStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || error instanceof Error)
    return undefined

  const { status } = error as { status?: unknown }

  return typeof status === 'number' ? status : undefined
}

const REPEATED_SLASHES = /\/{2,}/g

// The name of each action in a refusal.
const ACTION_NAMES: Record<CmsAction, () => string> = {
  publish: () => wording('cms.role.publish', 'publish or unpublish'),
  review: () => wording('cms.role.review', 'approve or send back an entry in review'),
  delete: () => wording('cms.role.delete', 'delete'),
  upload: () => wording('cms.role.upload', 'upload a file'),
  redirects: () => wording('cms.role.redirects', 'change redirects'),
}

const members = new WeakMap<Request, Promise<Member | undefined>>()
// The person once read, for a refusal that words itself by what they may reach.
const known = new WeakMap<Request, Member | undefined>()

async function resolved(ctx: GuardContext): Promise<Member | undefined> {
  const member = await readMember(ctx)

  known.set(ctx.request, member)

  return member
}

// Who is signed in on this request, from the password guard when it let the request in, else from kayjs-auth's session; read once per request.
export async function memberOf(ctx: GuardContext): Promise<Member | undefined> {
  const cached = members.get(ctx.request)

  if (cached)
    return cached

  const found = resolved(ctx)

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

    return given && { name: given.name ?? '', email: given.email, held: [...roles?.keys() ?? []].filter(role => given.roles.includes(role)) }
  }

  const auth = authOf(ctx)
  const user = await (auth?.bareUser ?? auth?.user)?.call(auth)

  if (!auth || !user)
    return undefined

  const owned = Array.isArray(user.roles) ? user.roles.filter(role => typeof role === 'string') : []
  const named = [...roles?.keys() ?? []]
  const held = [...named.filter(role => !isOrganizationRole(role)).filter(role => auth.isGranted ? auth.isGranted(role, user) : owned.includes(role)), ...await heldInOrganizations(auth, named)]
  const name = [user.username, user.email, user.id].find(value => (typeof value === 'string' && value !== '') || typeof value === 'number')
  const id = typeof user.id === 'string' || typeof user.id === 'number' ? String(user.id) : undefined

  return { name: String(name ?? ''), held, id, email: typeof user.email === 'string' && user.email !== '' ? user.email : undefined }
}

// A digest naming the signed-in person, keyed by the app's secret so a guessed email cannot be checked against it, which tells two people on one browser apart; the same for every person a guard without a name admits.
export async function whoOf(ctx: GuardContext): Promise<string> {
  const member = await memberOf(ctx)

  return keyedDigest('cms-editor', JSON.stringify([member?.name ?? '', member?.email ?? '']))
}

// What a person does: an action of `cms({ roles })`, or what editing needs. `read` opens a collection's screens and entries, `edit` writes an entry, and `move` reorders a collection, which rewrites the order of entries beside the one moved.
export type Doing = CmsAction | 'read' | 'edit' | 'move'

// What a person does it to. Without a collection it is the site's own: the redirects, the media library, the activity log, which a role limited to collections or to its own entries does not reach.
export interface Target {
  collection?: string | undefined
  // The entry concerned, `data` being what it holds now, none for an entry that is not there. Left out when the act is not about one entry: opening a collection, a new entry, an upload.
  entry?: { data?: Record<string, unknown> | undefined } | undefined
}

// The text a role's `own` field is compared with: the person's kayjs-auth id, else their email, else their name; empty for a person the guard did not name.
export function ownerKey(member: Member | undefined): string {
  const key = member?.id ?? member?.email ?? member?.name

  return key ?? ''
}

// Whether an entry's field names the person: a text or a number equal to their key, or a list holding one.
function written(field: unknown, key: string): boolean {
  if (key === '')
    return false

  if (Array.isArray(field))
    return field.some(item => written(item, key))

  return (typeof field === 'string' || typeof field === 'number') && String(field) === key
}

// Whether a role reaches a collection.
export function reaches(role: Role, collection: string): boolean {
  return role.collections === undefined || role.collections.has(collection)
}

function admits(role: Role, doing: Doing, target: Target, member: Member | undefined): boolean {
  if (doing !== 'read' && doing !== 'edit' && doing !== 'move' && !role.actions.has(doing))
    return false

  if (target.collection === undefined)
    return role.collections === undefined && role.own === undefined

  if (!reaches(role, target.collection))
    return false

  if (role.own === undefined || doing === 'read')
    return true

  if (doing === 'move')
    return false

  return target.entry === undefined || written(target.entry.data?.[role.own], ownerKey(member))
}

// Whether a role of the app is limited to some collections or to its own entries.
export function scoped(): boolean {
  return [...settings().roles?.values() ?? []].some(role => role.collections !== undefined || role.own !== undefined)
}

// Whether the person may do it, the guard having let them in: everyone may when the app lists no roles; a person none of whose roles is listed only edits and reads, unless a role of the app is limited to collections or to its own entries, which makes the list a promise that no one outside it reaches them; else one of their roles must reach the collection, hold the action and, when it is limited to their own entries, the entry must be theirs.
export function allows(member: Member | undefined, doing: Doing, target: Target = {}): boolean {
  const { roles } = settings()

  if (roles === undefined)
    return true

  const held = (member?.held ?? []).flatMap(name => roles.get(name) ?? [])

  if (held.length === 0 && (doing === 'read' || doing === 'edit' || doing === 'move'))
    return !scoped()

  return held.some(role => admits(role, doing, target, member))
}

// `allows`, then the app's own `cms({ can })`, which only narrows it. A `can` that throws or answers anything but true refuses.
export async function permits(member: Member | undefined, doing: Doing, target: Target = {}): Promise<boolean> {
  if (!allows(member, doing, target))
    return false

  const { can } = settings()

  if (can === undefined)
    return true

  try {
    const person = { id: member?.id, name: member?.name ?? '', email: member?.email, roles: member?.held ?? [] }

    return await can({ person, action: doing, collection: target.collection, entry: target.entry }) === true
  }
  catch {
    return false
  }
}

// The fields a new entry of the collection is written with the person in, and the values an existing one keeps: for a person whose roles reach the collection only through `own` fields. None when a role of theirs changes any entry of it.
export function ownerStamps(member: Member | undefined, collection: string, entry: Target['entry']): { field: string, value: unknown }[] {
  const { roles } = settings()
  const reaching = (member?.held ?? []).flatMap(name => roles?.get(name) ?? []).filter(role => reaches(role, collection))
  const key = ownerKey(member)

  // An existing entry keeps its writer unless a broader role holds it.
  if (reaching.some(role => role.own === undefined))
    return entry === undefined && reaching.some(role => role.own !== undefined) && key !== '' ? [...new Set(reaching.flatMap(role => role.own ?? []))].map(field => ({ field, value: key })) : []

  if (entry === undefined && key === '')
    return []

  return [...new Set(reaching.flatMap(role => role.own ?? []))].map(field => ({ field, value: entry === undefined ? key : entry.data?.[field] }))
}

// The things the signed-in person may not do, each with the reason a disabled control gives; empty when the app lists no roles. `edit` is set for what they may not change at all, `move` for reordering a collection.
export type Denials = Partial<Record<CmsAction | 'edit' | 'move', string>>

function deniedTo(member: Member | undefined, target: Target = {}): Denials {
  const { roles } = settings()
  const found: Denials = {}

  if (roles === undefined)
    return found

  for (const action of ACTIONS) {
    if (!allows(member, action, target))
      found[action] = refusal(action)
  }

  if (target.collection !== undefined && !allows(member, 'edit', target))
    found.edit = refusal('edit', allows(member, 'read', target))

  if (target.collection !== undefined && !allows(member, 'move', target))
    found.move = refusal('move')

  return found
}

export async function denials(ctx: GuardContext, target?: Target): Promise<Denials> {
  return deniedTo(settings().roles === undefined ? undefined : await memberOf(ctx), target)
}

// The same for a request the api guard has read the person of (it does for `/editor/can`, the one route that asks), as an API route has no guard context.
export async function denialsOf(request: Request, target?: Target): Promise<Denials> {
  return deniedTo(await members.get(request), target)
}

// Whether the signed-in person's roles reach a collection, for a screen that lists collections.
export async function reachOf(ctx: GuardContext): Promise<(collection: string) => boolean> {
  const member = await memberOf(ctx)

  return collection => allows(member, 'read', { collection })
}

// Who the api guard read the person of for this request, the one it reads for an entry's read when `cms({ fourEyes })` is on.
export async function memberOfRequest(request: Request): Promise<Member | undefined> {
  return members.get(request)
}

// The reason for what a person may not do; for `read` and `edit`, whether the collection is out of their reach or the entry is another's.
function refusal(doing: Doing, reachable = false): string {
  if (doing === 'read')
    return wording('cms.guard.outOfReach', 'Your role does not reach this collection')

  if (doing === 'edit')
    return reachable ? wording('cms.guard.notYours', 'Your role may only change the entries you wrote') : refusal('read')

  if (doing === 'move')
    return wording('cms.guard.moveOwn', 'Your role may only change the entries you wrote, and moving one changes the others')

  return wording('cms.guard.forbidden', 'Your role may not do this: {action}', { action: ACTION_NAMES[doing]() })
}

// Whether the signed-in person may do it: see `allows`.
export async function may(ctx: GuardContext, doing: Doing, target?: Target): Promise<boolean> {
  return settings().roles === undefined || allows(await memberOf(ctx), doing, target)
}

export function forbidden(ctx: GuardContext, doing: Doing, target?: Target): never {
  return ctx.deny(403, refusal(doing, doing === 'edit' && target !== undefined && allows(known.get(ctx.request), 'read', target)))
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
  for (const value of sessionCookiesOf(ctx.cookies))
    await activePasswords()?.revoke(value)

  ctx.cookies.delete({ name: HOST_SESSION_COOKIE, path: '/' })
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
