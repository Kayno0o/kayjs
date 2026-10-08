import { api, invalidatePage } from 'kay/server'
import { news } from '../content.config'

// What a CMS calls once an entry changed.
export default api().post('/', () => {
  news.invalidate()
  invalidatePage(path => path.startsWith('/news/'))

  return new Response(null, { status: 204 })
})
