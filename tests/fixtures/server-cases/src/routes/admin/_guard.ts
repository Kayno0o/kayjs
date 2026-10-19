import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (!request.headers.has('x-admin'))
    deny(403, 'Admins only')
})
