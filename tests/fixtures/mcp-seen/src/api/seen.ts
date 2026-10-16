import { api, toolCall } from 'kay/server'

export default api()
  .get('/', ({ request }) => ({ tool: toolCall(request)?.tool ?? null }), { detail: { tool: true } })
