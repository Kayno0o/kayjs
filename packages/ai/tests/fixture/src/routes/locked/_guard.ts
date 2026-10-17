import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (request.headers.get('authorization') !== 'Bearer open')
    deny(401, 'Sign in')
})
