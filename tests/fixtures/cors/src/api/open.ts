import { api } from 'kay/server'

export default api({ cors: { origins: '*', headers: ['content-type'], maxAge: '10m' } })
  .get('/', () => ({ open: true }))
  .post('/', () => ({ posted: true }))
