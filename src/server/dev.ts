import { Elysia } from 'elysia'
import { KayCompileError } from '../build/transform'
import { compileErrorPage } from './overlay'

export const DEV_EVENTS = '/_kay/dev/events'

// One per server process: `kay dev` restarts the process on every change, so a new id means new code.
const BOOT_ID = crypto.randomUUID()

// Reconnects once the restarted server is up and reloads when its boot id differs from the one this page was served by.
export const LIVE_RELOAD = `<script>new EventSource(${JSON.stringify(DEV_EVENTS)}).addEventListener('boot',e=>{if(e.data!==${JSON.stringify(BOOT_ID)})location.reload()})</script>`

// The stream stays open until the process exits; `retry` makes the browser poll quickly for the next one.
export function devEvents(): Response {
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(`retry: 100\nevent: boot\ndata: ${BOOT_ID}\n\n`)
    },
  })

  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

// What a dev server serves when the project failed to boot: the errors on every page, until a fix restarts it.
export function bootFailure(error: unknown, seed: string): Elysia {
  const html = compileErrorPage(error instanceof KayCompileError ? error.diagnostics : [], error) + LIVE_RELOAD

  const app = new Elysia({ name: 'kay/pages', seed })

  app.get(DEV_EVENTS, devEvents)
  app.get('/*', () => new Response(html, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }))

  return app
}
