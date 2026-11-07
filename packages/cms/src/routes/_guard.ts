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

// The collection a screen's path names, whatever the base and the slashes before the prefix; undefined for a screen of none, and for a path the prefix is not in, which is then refused as the API refuses one it cannot place.
function screenCollection(ctx: GuardContext): string | undefined | null {
  const { prefix } = settings()
  const path = routePath(ctx.url)
  const at = prefix === '/' ? 0 : path.indexOf(`${prefix}/`)

  if (path === prefix)
    return undefined

  if (at < 0)
    return null

  const [, name] = COLLECTION_SCREEN.exec(path.slice(at + (prefix === '/' ? 0 : prefix.length))) ?? []

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

  // A role limited to some collections opens no other collection's screens.
  const named = settings().roles === undefined ? undefined : screenCollection(ctx)

  if (named === null)
    return ctx.deny(403, wording('cms.guard.unplaced', 'The cms could not place this request among its routes'))

  if (named !== undefined && !await may(ctx, 'read', { collection: named }))
    return forbidden(ctx, 'read', { collection: named })

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
