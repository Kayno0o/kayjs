import { s } from 'kay'
import { api } from 'kay/server'

// A module raising its limit with a function, as kayjs-cms's upload route does with the size its settings give.
export default api({ maxSize: () => 5 * 1024 * 1024 })
  .post('/', ({ body }) => ({ size: body.file.size }), { body: s.Object({ file: s.File() }) })
