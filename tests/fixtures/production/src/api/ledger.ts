import { api } from 'kay/server'

// Ids past what a number holds, as a database's bigint column gives them.
export default api()
  .get('/', () => ({ id: 9007199254740993n, entries: [1n, { amount: 2n }] }))
  .get('/created', ({ set }) => {
    set.status = 201
    set.headers['x-ledger'] = 'kept'

    return [3n]
  })
