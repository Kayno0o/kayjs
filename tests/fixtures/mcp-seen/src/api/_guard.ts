import { guard } from 'kay'
import { toolCall } from 'kay/server'

// The key opens tool calls alone.
export default guard(({ request, deny }) => {
  if (request.headers.get('authorization') === 'Bearer key' && toolCall(request) === undefined)
    deny(403, 'The key opens tools only')
})
