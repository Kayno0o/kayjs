import { guard } from 'kay'

export default guard(({ request, locals, deny }) => {
  if (request.headers.get('authorization') !== 'Bearer open' && (locals as { key?: string }).key !== 'open')
    deny(401, 'Sign in')
})
