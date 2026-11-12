import type { GuardContext } from 'kay'
import type { Doing, Member, Target } from './access'
import type { CmsAction } from './roles'
import { READ_METHODS } from 'kay/library'
import { allows, forbidden, memberOf, ownerStamps, permits, scoped } from './access'
import { stamps } from './authors'
import { leavesPublication, restrain } from './publishing'
import { referencingCollections, referrersWith } from './references'
import { settings } from './settings'
import { entryScreen } from './store'
import { trashed } from './trash'

// A path segment as the route reads it, or as written when it is not valid.
export function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment)
  }
  catch {
    return segment
  }
}

// The routes that name a collection and an entry: `/entries/<collection>/<slug>` and what follows it, a history's restore or erasure, a newsletter's preview, test or send.
const ENTRY_ROUTE = /^\/(entries|history|newsletter)\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/
// The routes that name a collection alone: its entries as choices, its uploads, its slugs, the entries that refer to it.
const COLLECTION_ROUTE = /^\/(entries|files|slugs|referrers)\/([^/]+)$/
const TRASH_RESTORE = /^\/trash\/([^/]+)\/([^/]+)\/restore$/
const IMAGE = /^\/markdown\/image$/
// What belongs to the site rather than to a collection.
const REDIRECTS = /^\/redirects(?:\/|$)/
const MEDIA_RENAME = /^\/files\/media\/rename$/
const UNUSED_UPLOADS = /^\/files\/unused\/delete$/
const FORGET_EDITOR = /^\/history\/forget-editor$/

// What an entry route does by the last segment of its path, with the action of `cms({ roles })` it asks. Sharing a draft shows what is not published (and revoking the links is as much a publisher's), and mailing a list sends what an editor wrote, so both are a publisher's.
const SUFFIXES: Record<string, { action?: CmsAction, edit?: boolean, move?: boolean }> = {
  'publish': { action: 'publish' },
  'unpublish': { action: 'publish' },
  'share': { action: 'publish' },
  'revoke-shares': { action: 'publish' },
  'preview': { action: 'publish' },
  'test': { action: 'publish' },
  'send': { action: 'publish' },
  'submit': { edit: true },
  'approve': { action: 'review' },
  'send-back': { action: 'review' },
  'duplicate': { edit: true },
  'rename': { action: 'redirects', edit: true },
  'move': { move: true },
  'restore': { edit: true },
  'erase': { action: 'delete' },
}

interface Check {
  doing: Doing
  target: Target
}

// The locale the route will read, as it reads it: a save, a history's restore or erasure take the body's `locale` and ignore the query's, every other entry route takes the query's. Undefined when it cannot be told, a body that is not JSON or names a locale that is no text, or a query that disagrees with the body's, which the guard and the route could then read differently.
async function localeOf(request: Request, url: URL, inBody: boolean): Promise<{ locale: string | undefined } | undefined> {
  const queried = url.searchParams.get('locale') ?? undefined

  if (!inBody)
    return { locale: queried }

  try {
    const { locale } = await request.clone().json() as { locale?: unknown }

    if (locale !== undefined && typeof locale !== 'string')
      return undefined

    return queried !== undefined && queried !== locale ? undefined : { locale }
  }
  catch {
    return undefined
  }
}

// The entry as it is stored now: `found` with its data, `absent` when the collection answered and holds none, and `unknown` when that cannot be told: a locale the guard cannot read, a collection that fails to read. Only `absent` is a new entry.
type Stored = { state: 'found', data: Record<string, unknown> } | { state: 'absent' } | { state: 'unknown' }

async function stored(collection: string, slug: string, read: { locale: string | undefined } | undefined): Promise<Stored> {
  if (read === undefined)
    return { state: 'unknown' }

  try {
    const screen = await entryScreen({ collection, slug, locale: read.locale })

    if (screen === undefined || screen.collection.problem !== undefined)
      return { state: 'unknown' }

    return screen.entry === undefined ? { state: 'absent' } : { state: 'found', data: screen.entry.data ?? {} }
  }
  catch {
    return { state: 'unknown' }
  }
}

// The entry a check is made against: none for a new one, and data nobody wrote for one that cannot be told, which no role limited to its own entries changes.
function targetOf(found: Stored): Target['entry'] {
  return found.state === 'absent' ? undefined : { data: found.state === 'found' ? found.data : undefined }
}

// The entries a rename would rewrite, those naming the entry in a reference field, as the checks to pass: each must be the person's to change. A reference that cannot be listed fails the rename.
async function rewritten(collection: string, slug: string): Promise<Check[] | undefined> {
  try {
    const found = (await referrersWith(collection, [slug], { strict: true })).get(slug) ?? []

    return found.map(({ collection: other, entry }) => ({ doing: 'edit', target: { collection: other.name, entry: { data: entry.data } } }))
  }
  catch {
    return undefined
  }
}

// Where a path points: the collection it names, and the entry and what is done to it when it names one.
interface Place {
  kind: string
  collection: string | undefined
  slug: string | undefined
  suffix: string | undefined
  // A route naming a collection alone, or an entry.
  alone: boolean
}

function placeOf(path: string): Place {
  const trash = TRASH_RESTORE.exec(path)

  if (trash)
    return { kind: 'trash', collection: decoded(trash[1]!), slug: decoded(trash[2]!), suffix: 'restore', alone: false }

  const alone = COLLECTION_ROUTE.exec(path)

  if (alone)
    return { kind: alone[1]!, collection: decoded(alone[2]!), slug: undefined, suffix: undefined, alone: true }

  const [, kind, collection, slug, suffix] = ENTRY_ROUTE.exec(path) ?? []

  return { kind: kind ?? '', collection: collection === undefined ? undefined : decoded(collection), slug: slug === undefined ? undefined : decoded(slug), suffix, alone: false }
}

// Whether the route reads the locale from the body: a save, and a history's restore or erasure.
function inBody({ kind, suffix }: Place, method: string): boolean {
  return method === 'POST' && ((kind === 'entries' && suffix === undefined) || kind === 'history')
}

// What a request needs of the signed-in person's roles, from its method and path as the router reads them (the path below the cms's mount).
async function needs(ctx: GuardContext, path: string, place: Place): Promise<Check[]> {
  const { method } = ctx.request
  const read = READ_METHODS.has(method)
  const { kind, collection, slug, suffix } = place

  if (REDIRECTS.test(path))
    return [{ doing: 'redirects', target: {} }]

  if (method === 'POST' && MEDIA_RENAME.test(path))
    return [{ doing: 'upload', target: {} }]

  if (UNUSED_UPLOADS.test(path) || (method === 'POST' && FORGET_EDITOR.test(path)))
    return [{ doing: 'delete', target: {} }]

  if (read && IMAGE.test(path)) {
    const named = ctx.url.searchParams.get('collection')

    return named === null ? [] : [{ doing: 'read', target: { collection: named } }]
  }

  if (collection === undefined)
    return []

  if (kind === 'trash')
    return method === 'POST' ? [{ doing: 'edit', target: { collection, entry: { data: (await trashed(collection, slug!))?.data } } }] : []

  if (place.alone) {
    if (kind === 'files' && !read)
      return [{ doing: 'upload', target: { collection } }]

    // What the editor asks first, the limits of an upload.
    if (kind === 'files' && collection === 'rules')
      return []

    // The choices of a reference field are answered by `enforceRoles` (`mayPick`).
    return kind === 'entries' && read ? [] : [{ doing: 'read', target: { collection } }]
  }

  if (read)
    return [{ doing: 'read', target: { collection } }]

  const found = scoped() || settings().can !== undefined ? await stored(collection, slug!, await localeOf(ctx.request, ctx.url, inBody(place, method))) : { state: 'unknown' } as const
  // A save of an entry the collection positively lacks makes it, which a role limited to its own entries may.
  const creating = suffix === undefined && method === 'POST' && found.state === 'absent'
  const target: Target = { collection, entry: creating ? undefined : targetOf(found) }

  if (suffix === undefined)
    return method === 'DELETE' ? [{ doing: 'edit', target }, { doing: 'delete', target }] : [{ doing: 'edit', target }]

  const rule = SUFFIXES[suffix]

  if (rule === undefined)
    return [{ doing: 'edit', target }]

  const checks: Check[] = []

  if (rule.action !== undefined)
    checks.push({ doing: rule.action, target })

  if (rule.edit)
    checks.push({ doing: 'edit', target })

  if (rule.move)
    checks.push({ doing: 'move', target: { collection } })

  return checks
}

// Whether the person may be given the titles of `collection` to pick from: they read it, or read a collection with a reference field to it, so a field can point where the role cannot go and no further.
async function mayPick(member: Member | undefined, collection: string): Promise<boolean> {
  if (await permits(member, 'read', { collection }))
    return true

  for (const referring of await referencingCollections(collection)) {
    if (await permits(member, 'read', { collection: referring.name }))
      return true
  }

  return false
}

// Refuses a request the signed-in person's roles do not cover: every action, in the collection and on the entry it names. Hiding a control is for the person's comfort; this is the check.
export async function enforceRoles(ctx: GuardContext, path: string): Promise<void> {
  const { method } = ctx.request
  const place = placeOf(path)
  const { kind, collection, slug, suffix } = place
  const limited = scoped()
  // Reading and editing are limited by a scope alone.
  const asked = settings().can !== undefined
  const checks = (await needs(ctx, path, place)).filter(({ doing }) => limited || asked || (doing !== 'read' && doing !== 'edit' && doing !== 'move'))
  // A read nothing limits does not look the person up.
  const picking = kind === 'entries' && place.alone && READ_METHODS.has(method) && (limited || asked)
  const member = checks.length === 0 && !picking && READ_METHODS.has(method) ? undefined : await memberOf(ctx)

  if (picking && !await mayPick(member, collection!))
    return forbidden(ctx, 'read', { collection })

  for (const { doing, target } of checks) {
    if (!await permits(member, doing, target))
      return forbidden(ctx, doing, target)
  }

  const saving = method === 'POST' && kind === 'entries' && collection !== undefined && slug !== undefined

  // A save writes the person into a new entry and keeps the writer of an existing one; so does a restore of an older version, whose data carries the writer it had then.
  if ((saving && suffix === undefined) || (method === 'POST' && kind === 'history' && suffix === 'restore' && collection !== undefined && slug !== undefined)) {
    const found = await stored(collection, slug, await localeOf(ctx.request, ctx.url, true))
    const list = ownerStamps(member, collection, targetOf(found))

    if (list.length > 0)
      stamps.set(ctx.request, list)
  }

  if (saving && suffix === 'rename' && (scoped() || settings().can !== undefined)) {
    const touched = await rewritten(collection, slug)

    if (touched === undefined)
      return forbidden(ctx, 'edit', { collection })

    for (const { doing, target } of touched) {
      if (!await permits(member, doing, target))
        return forbidden(ctx, doing, target)
    }
  }

  const mayPublish = allows(member, 'publish', { collection })

  // Restoring undoes an edit or a delete, which any editor may; what it restores never publishes or withdraws for a role that may not.
  if (method === 'POST' && suffix === 'restore' && !mayPublish)
    restrain(ctx.request)

  // A save that flips the draft flag or a publish date is a publish as much as the route is.
  if (saving && suffix === undefined && !mayPublish && !await leavesPublication(ctx.request, path))
    return forbidden(ctx, 'publish')
}
