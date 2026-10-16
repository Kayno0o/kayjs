import { api } from 'kay/server'
import { news } from '../content.config'

// What a CMS calls once an entry changed.
export default api().post('/', () => {
  news.invalidate()

  return new Response(null, { status: 204 })
})
