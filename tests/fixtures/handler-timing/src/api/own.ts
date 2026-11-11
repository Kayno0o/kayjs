import { api } from 'kay/server'

export default api().get('/', ({ set }) => {
  set.headers['server-timing'] = 'upstream;dur=1'

  return 'own'
})
