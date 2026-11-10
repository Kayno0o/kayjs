import type { GuardContext } from 'kay'
import { guard } from 'kay'
import { overHttps } from 'kay/library'
import { wording } from 'kay/words'
import { forbidden, may, routePath, sendToSignIn, whoOf } from '../access'
import { admitEditor } from '../editor-names'
import { EDITOR_COOKIE, editorCookie, hintCookie } from '../page-link'
import { settings } from '../settings'

// The screens of a collection, below the prefix: its list, an entry, a new entry, its trash, an entry's history.
const COLLECTION_SCREEN = /^\/(?:collections|new|trash|history)\/([^/]+)/

// The screens of the site rather than of a collection, which a role limited to collections or to its own entries does not reach.
const SITE_SCREEN = /^\/(?:media|uploads)$/

// The path below the prefix, whatever the base and the slashes before the prefix; empty for the prefix itself, and null for a path the prefix is not in, which is then refused as the API refuses one it cannot place.
function belowPrefix(ctx: GuardContext): string | null {
  const { prefix } = settings()
  const path = routePath(ctx.url)

  if (path === prefix)
    return ''

  const at = prefix === '/' ? 0 : path.indexOf(`${prefix}/`)

  return at < 0 ? null : path.slice(at + (prefix === '/' ? 0 : prefix.length))
}

// The collection a screen's path names; undefined for a screen of none.
function screenCollection(below: string): string | undefined {
  const [, name] = COLLECTION_SCREEN.exec(below) ?? []

  try {
    return name === undefined ? undefined : decodeURIComponent(name)
  }
  catch {
    return name
  }
}

// The screens are the app's guard's to open; without one they stay closed. A visitor it turns away as anonymous goes to sign in and comes back to this page.
export default guard(async (ctx) => {
  const { guard: admits, pageLink } = settings()

  if (!admits)
    return ctx.deny(403, 'kayjs-cms has no guard: give cms() a kayjs-auth role, cms({ role: \'editor\' }), or a guard such as passwordGuard()')

  try {
    await admits(ctx)
  }
  catch (error) {
    sendToSignIn(ctx, error)

    throw error
  }

  const below = settings().roles === undefined ? undefined : belowPrefix(ctx)

  if (below === null)
    return ctx.deny(403, wording('cms.guard.unplaced', 'The cms could not place this request among its routes'))

  // A role limited to some collections opens no other collection's screens, nor the site's.
  const named = below === undefined ? undefined : screenCollection(below)

  if (named !== undefined && !await may(ctx, 'read', { collection: named }))
    return forbidden(ctx, 'read', { collection: named })

  if (below !== undefined && SITE_SCREEN.test(below) && !await may(ctx, 'read'))
    return forbidden(ctx, 'site')

  // The edit cookie this browser holds is an editor's from here on, so the on-page editor is told the names too.
  admitEditor(ctx)

  // An editor the guard let in is marked for the pages they read next, which show them the link into edit mode.
  if (pageLink)
    ctx.cookies.set(hintCookie(overHttps(ctx.request)))

  // Who is signed in, for the drafts the on-page editor keeps in this browser to be theirs alone.
  const who = await whoOf(ctx)

  if (ctx.cookies.get(EDITOR_COOKIE) !== who)
    ctx.cookies.set(editorCookie(overHttps(ctx.request), who))
})
