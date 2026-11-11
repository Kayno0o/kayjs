import { eventStream } from 'kay/library'
import { api } from 'kay/server'

// Names this process, so an editor tells a redeploy from the same server: a forge-backed site is rebuilt and replaced, and the instance a stream reconnects to is another.
const INSTANCE = crypto.randomUUID()

// The id of this instance, sent as the stream opens and then held open: it ends when the server stops, and the editor's browser reads the id again from the one that replaces it.
export default api()
  .get('/', () => eventStream(async function* (signal: AbortSignal) {
    yield INSTANCE

    await new Promise<void>((resolve) => {
      if (signal.aborted)
        resolve()
      else
        signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }))
