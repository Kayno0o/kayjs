import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (request.headers.get('x-member') !== 'yes')
    deny(401, 'Sign in')
})
