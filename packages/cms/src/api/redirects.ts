import { s } from 'kay'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { addRedirect, removeRedirect } from '../missing'
import { settings } from '../settings'

// Only whom the app's guard admits may add or remove a redirect, since an edit cookie is tied to no user and a redirect answers every visitor.
export default api()
  .post('/', ({ body, status }) => {
    if (!settings().guard)
      return status(403, wording('cms.redirects.needsGuard', 'Redirects need cms({ guard })'))

    const refusal = addRedirect(body.from, body.to, body.permanent)

    return refusal === undefined ? { added: true } : status(400, refusal)
  }, { body: s.Object({ from: s.String({ maxLength: 512 }), to: s.String({ maxLength: 512 }), permanent: s.Optional(s.Boolean()) }) })
  .post('/remove', ({ body, status }) => {
    if (!settings().guard)
      return status(403, wording('cms.redirects.needsGuard', 'Redirects need cms({ guard })'))

    return { removed: removeRedirect(body.from) }
  }, { body: s.Object({ from: s.String({ maxLength: 512 }) }) })
