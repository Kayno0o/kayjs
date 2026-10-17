import { actionTool, currentRequest } from 'kay/library'
import { api } from 'kay/server'
import { addNote } from '../routes/targets/_actions.kay'

// A route's handler runs in Elysia's call, outside the request kay answers, so it passes its own request.
export default api()
  .get('/', () => ({ url: currentRequest()?.url ?? null }))
  .post('/tool', async ({ request, body }) => actionTool(addNote)!.call(body as Record<string, unknown>, request))
