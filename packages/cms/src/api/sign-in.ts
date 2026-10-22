import { apiUrl, localPath, s } from 'kay'
import { api } from 'kay/server'
import { screenPath } from '../paths'
import { settings } from '../settings'

const TRAILING_SLASH = /\/$/

// Where an editor whose sign-in ended goes to sign in again, from the editor's own tab: the sign-in screen, leading back to `redirect`. No guard runs, as the editor has none to show.
const signIn = api({ guards: false })
  .get('/', ({ request, query }) => {
    const path = new URL(request.url).pathname.replace(TRAILING_SLASH, '')
    const mount = apiUrl(request, '/')
    const base = path.endsWith(mount) ? path.slice(0, -mount.length) : ''
    const back = localPath(query.redirect, settings().prefix)

    return new Response(null, { status: 302, headers: { location: localPath(`${base}${screenPath(settings().prefix, '/sign-in')}?redirect=${encodeURIComponent(back)}`, '/') } })
  }, { query: s.Object({ redirect: s.Optional(s.String({ maxLength: 2000 })) }) })

export default signIn
