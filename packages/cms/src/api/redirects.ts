import { s } from 'kay'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { addRedirect, clearPaths, dismissPaths, MAX_BULK, removeRedirects, sitePathsLike } from '../missing'
import { settings } from '../settings'

function needsGuard(): string {
  return wording('cms.redirects.needsGuard', 'Redirects need cms({ role }) or cms({ guard })')
}

const STATUS = s.Optional(s.Union([s.Literal(301), s.Literal(302), s.Literal(307), s.Literal(308), s.Literal(410)]))
const PATHS = s.Array(s.String({ maxLength: 512 }), { maxItems: MAX_BULK })

// Only whom the app's guard admits may change a redirect or the list of missing pages, since an edit cookie is tied to no user and a redirect answers every visitor.
export default api()
  .post('/', ({ body, status }) => {
    if (!settings().guard)
      return status(403, needsGuard())

    const refusal = addRedirect(body.from, body.to, body.status ?? (body.permanent ? 308 : 307))

    return refusal === undefined ? { added: true } : status(400, refusal)
  }, { body: s.Object({ from: s.String({ maxLength: 512 }), to: s.String({ maxLength: 512 }), status: STATUS, permanent: s.Optional(s.Boolean()) }) })
  .get('/paths', ({ query }) => sitePathsLike(query.q ?? ''), { query: s.Object({ q: s.Optional(s.String({ maxLength: 512 })) }) })
  .post('/remove', ({ body, status }) => {
    return !settings().guard ? status(403, needsGuard()) : { removed: removeRedirects([...body.froms ?? [], ...body.from === undefined ? [] : [body.from]]) }
  }, { body: s.Object({ froms: s.Optional(PATHS), from: s.Optional(s.String({ maxLength: 512 })) }) })
  .post('/dismiss', ({ body, status }) => {
    return !settings().guard ? status(403, needsGuard()) : { dismissed: dismissPaths(body.paths) }
  }, { body: s.Object({ paths: PATHS }) })
  .post('/clear', ({ status }) => {
    return !settings().guard ? status(403, needsGuard()) : { cleared: clearPaths() }
  })
