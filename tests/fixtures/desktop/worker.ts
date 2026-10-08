import { parentPort } from 'node:worker_threads'
import { Elysia } from 'elysia'
import { pages } from '../../../src/server'
import { startDesktopServer } from '../../../src/server/internal'

// Started by tests/desktop.test.ts as the worker a desktop executable runs, on the port the test sends first whatever port its entry asks for.
startDesktopServer(await new Promise<number>(resolve => parentPort!.once('message', resolve)))

new Elysia()
  .get('/before', () => 'registered before pages()')
  .use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false }))
  .ws('/echo', { message: (ws, message) => ws.send(message) })
  .onStop(() => parentPort?.postMessage({ kind: 'stop hook' }))
  .listen(3000)
