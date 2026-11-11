import { api } from 'kay/server'

export default api().get('/', () => {
  throw new Error('boom')
})
