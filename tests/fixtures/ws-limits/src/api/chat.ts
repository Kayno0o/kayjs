import { api } from 'kay/server'

function echo(ws: { send: (data: string) => unknown }, message: unknown): void {
  ws.send(`echo:${typeof message === 'string' ? message.length : JSON.stringify(message).length}`)
}

// Each route sets a different limit, or none, so a test reads which one applied.
export default api()
  .ws('/', { message: echo })
  .ws('/big', { detail: { messages: { maxSize: '4mb' } }, message: echo })
  .ws('/tiny', { detail: { messages: { maxSize: 100 } }, message: echo })
  .ws('/slow', { detail: { messages: { rateLimit: { max: 3, window: '10s' } } }, message: echo })
  .ws('/fast', { detail: { messages: { rateLimit: { max: 1000, window: '1s' } } }, message: echo })
