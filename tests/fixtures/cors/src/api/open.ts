import { api } from 'kay/server'

export default api({ cors: { origins: '*', headers: ['content-type'], maxAge: '10m' } })
  .get('/', () => ({ open: true }))
  .post('/', () => ({ posted: true }))
  .all('/any', () => 'any')
  .get('/own-grant', () => new Response('own', { headers: { 'access-control-allow-origin': 'https://elsewhere.example', 'access-control-allow-credentials': 'true' } }))
