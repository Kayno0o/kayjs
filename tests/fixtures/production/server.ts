import { Elysia } from 'elysia'
import { pages } from '../../../src/server'

// Started by tests/production.test.ts in a process of its own, to be stopped by a signal.
new Elysia()
  .use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false, shutdownTimeout: Number(process.env.SHUTDOWN_TIMEOUT ?? 10) }))
  .get('/slow', async () => {
    console.log('slow started')
    await Bun.sleep(Number(process.env.SLOW_MS ?? 300))

    return 'slow done'
  })
  .onStop(async () => {
    await Bun.sleep(50)
    console.log('jobs stopped')
  })
  .listen(0)
