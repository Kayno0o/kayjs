import { Elysia } from 'elysia'
import { pages } from '../../../src/server'
import { startDesktopServer } from '../../../src/server/internal'

// Started by tests/desktop.test.ts as the worker a desktop executable runs, whatever port its entry asks for.
startDesktopServer()

new Elysia()
  .get('/before', () => 'registered before pages()')
  .use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false }))
  .ws('/echo', { message: (ws, message) => ws.send(message) })
  .onStop(() => console.log('stop hooks ran'))
  .listen(3000)
