import { s } from 'kay'
import { api } from 'kay/server'
import { wording } from 'kay/words'
import { addRedirect, clearPaths, dismissPaths, MAX_BULK, removeRedirects, sitePathsLike } from '../missing'
import { settings } from '../settings'

function needsGuard(): string {
  return wording('cms.redirects.needsGuard', 'Redirects need cms({ access })')
}

const STATUS = s.union([s.literal(301), s.literal(302), s.literal(307), s.literal(308), s.literal(410)], { optional: true })
const paths = <const Options extends { optional?: boolean }>(options?: Options) => s.list(s.string({ max: 512 }), { max: MAX_BULK, ...options })

// Only whom the app's guard admits may change a redirect or the list of missing pages, since an edit cookie is tied to no user and a redirect answers every visitor.
export default api()
  .post('/', async ({ body, status }) => {
    if (!settings().guard)
      return status(403, needsGuard())

    const refusal = await addRedirect(body.from, body.to, body.status ?? (body.permanent ? 308 : 307))

    return refusal === undefined ? { added: true } : status(400, refusal)
  }, { body: s.object({ from: s.string({ max: 512 }), to: s.string({ max: 512 }), status: STATUS, permanent: s.boolean({ optional: true }) }) })
  .get('/paths', ({ query }) => sitePathsLike(query.q ?? ''), { query: s.object({ q: s.string({ optional: true, max: 512 }) }, { extra: 'strip' }) })
  .post('/remove', async ({ body, status }) => {
    return !settings().guard ? status(403, needsGuard()) : { removed: await removeRedirects([...body.froms ?? [], ...body.from === undefined ? [] : [body.from]]) }
  }, { body: s.object({ froms: paths({ optional: true }), from: s.string({ optional: true, max: 512 }) }) })
  .post('/dismiss', async ({ body, status }) => {
    return !settings().guard ? status(403, needsGuard()) : { dismissed: await dismissPaths(body.paths) }
  }, { body: s.object({ paths: paths() }) })
  .post('/clear', async ({ status }) => {
    return !settings().guard ? status(403, needsGuard()) : { cleared: await clearPaths() }
  })
