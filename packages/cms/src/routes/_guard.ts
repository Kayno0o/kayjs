import { guard } from 'kay'
import { overHttps } from 'kay/library'
import { sendToSignIn, whoOf } from '../access'
import { admitEditor } from '../editor-names'
import { EDITOR_COOKIE, editorCookie, hintCookie } from '../page-link'
import { settings } from '../settings'

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
