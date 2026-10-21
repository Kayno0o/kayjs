import { api } from 'kay/server'
import { wording } from 'kay/words'
import { hintCookie, pageLinkModule } from '../page-link'
import { screenPath } from '../paths'
import { settings } from '../settings'

export default api()
  // Answers only a request the app's guard lets through, so a browser holding the hint learns whether its session still stands; it slides the hint forward, as the session slides.
  .get('/', ({ request, set }) => {
    set.headers['cache-control'] = 'no-store'
    // Beside any cookie the guard already set.
    set.headers['set-cookie'] = [set.headers['set-cookie'] ?? []].flat().concat(hintCookie(new URL(request.url).protocol === 'https:').serialize())

    return { label: wording('cms.page.edit', 'Edit this page'), href: screenPath(settings().prefix, '/page') }
  })
  // What an editor's browser runs on each page, the same bytes for everyone and no secret in them; the guard leaves it open so a stale hint is found and cleared.
  .get('/module.js', ({ set }) => {
    set.headers['content-type'] = 'text/javascript; charset=utf-8'
    set.headers['cache-control'] = 'public, max-age=300'

    return pageLinkModule()
  })
