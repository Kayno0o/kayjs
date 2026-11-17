import { api } from 'kay/server'
import { described, plain } from '../validators'

export default api()
  .post('/', ({ body }) => ({ age: body.age }), { body: described })
  .get('/query', ({ query }) => ({ age: query.age }), { query: described })
  .post('/plain', ({ body }) => ({ age: body.age }), { body: plain })
