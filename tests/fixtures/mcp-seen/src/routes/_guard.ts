import { guard } from 'kay'
import { toolCall } from 'kay/server'

// The key opens the endpoint and the tool calls it dispatches, nothing else.
export default guard(({ request, url, deny }) => {
  if (request.headers.get('authorization') === 'Bearer key' && url.pathname !== '/mcp' && toolCall(request) === undefined)
    deny(403, 'The key opens tools only')
})
