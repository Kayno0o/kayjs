import { guard } from 'kay'

// A bearer token in the header, or one the app read for the request, as a session would hold it.
export default guard(({ request, locals, deny }) => {
  const token = request.headers.get('authorization')

  if (token !== 'Bearer open' && token !== 'Bearer reader' && (locals as { key?: string }).key !== 'open')
    deny(401, 'Sign in')

  if (token === 'Bearer reader')
    deny(403, 'Not for readers')
})
