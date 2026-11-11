import { guard } from 'kay'

export default guard(({ request, deny }) => {
  if (!request.headers.has('authorization'))
    deny(401, 'Sign in first')
})
