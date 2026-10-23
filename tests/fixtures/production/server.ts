import { Elysia } from 'elysia'
import { eventStream, pages, queue, sqliteJobs, sqliteRooms } from '../../../src/server'
import { setupStore } from '../../../src/server/app-store'

// Started by tests/production.test.ts in a process of its own, to be stopped by a signal.
const app = new Elysia()
  .use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false, shutdownTimeout: Number(process.env.SHUTDOWN_TIMEOUT ?? 10) }))
  .get('/slow', async () => {
    console.log('slow started')
    await Bun.sleep(Number(process.env.SLOW_MS ?? 300))

    return 'slow done'
  })
  // An event stream that never ends by itself, as a live connection does.
  .get('/stream', () => {
    console.log('stream started')

    return eventStream(async function* () {
      yield 1
      await new Promise(() => undefined)
    })
  })
  .onStop(async () => {
    await Bun.sleep(50)
    console.log('jobs stopped')
  })

// The files stand for a stopped server's jobs and rooms, which the test reads back.
if (process.env.JOBS_PATH && process.env.ROOMS_PATH) {
  const rooms = sqliteRooms(process.env.ROOMS_PATH)
  const jobs = queue('stuck', async () => {
    console.log('job started')
    // Ignores its signal.
    await new Promise(() => undefined)
  }, { store: sqliteJobs(process.env.JOBS_PATH) })

  setupStore({ rooms })
  app.use(jobs).get('/join', () => {
    rooms.add('lobby', 'tab-1', 'visitor')
    void jobs.enqueue({})

    return 'joined'
  })
}

app.listen(0)
