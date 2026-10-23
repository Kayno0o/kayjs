import { Elysia } from 'elysia'
import { eventStream, pages, pgData, queue, schedule, sqliteJobs, sqliteRooms } from '../../../src/server'
import { setupStore } from '../../../src/server/app-store'

// Started by tests/production.test.ts in a process of its own, to be stopped by a signal.
const app = new Elysia()
  .use(await pages({ routes: 'tests/fixtures/production/src/routes', prebuilt: false, security: false, shutdownTimeout: Number(process.env.SHUTDOWN_TIMEOUT ?? 10) }))
  .get('/slow', async () => {
    console.log('slow started')
    await Bun.sleep(Number(process.env.SLOW_MS ?? 300))

    return 'slow done'
  })
  // A request that never answers.
  .get('/hang', async () => {
    console.log('hang started')
    await new Promise(() => undefined)
  })
  // An event stream that never ends by itself, as a live connection does.
  .get('/stream', () => {
    console.log('stream started')

    return eventStream(async function* () {
      yield 1
      await new Promise(() => undefined)
    })
  })
  // A stream whose handler answers once the stop began, as one waiting on a session check does.
  .get('/late', async () => {
    console.log('late started')
    await Bun.sleep(300)

    return eventStream(async function* () {
      yield 1
      await new Promise(() => undefined)
    })
  })
  .onStop(async () => {
    await Bun.sleep(50)
    console.log('jobs stopped')
  })

// A socket that stays open, as a chat tab's does.
app.ws('/socket', {
  open() {
    console.log('socket open')
  },
})

// The jobs and rooms of a stopped server, which the test reads back: in the SQLite files JOBS_PATH and ROOMS_PATH, or in the Postgres DATABASE_URL names. ROLE splits one app over two processes sharing them: `web` enqueues and holds the members, `worker` runs the jobs.
const role = process.env.ROLE
const data = process.env.DATABASE_URL ? pgData(process.env.DATABASE_URL) : undefined

if (data || (process.env.JOBS_PATH && process.env.ROOMS_PATH)) {
  const rooms = data ? data.rooms : sqliteRooms(process.env.ROOMS_PATH!)
  const store = data ? data.jobs : sqliteJobs(process.env.JOBS_PATH!)
  // Ignores its signal.
  const handler = async () => {
    console.log('job started')
    await new Promise(() => undefined)
  }
  const options = { store, idlePoll: '1s' } as const
  const jobs = queue('stuck', handler, options)
  const others = queue('stuck-too', handler, options)

  setupStore({ rooms })

  if (role !== 'web')
    app.use(jobs).use(others)

  app.get('/join', () => {
    rooms.add('lobby', 'tab-1', 'visitor')
    void jobs.enqueue({})
    void others.enqueue({})

    return 'joined'
  })
}

// A schedule whose boot run ignores its signal.
if (process.env.SCHEDULE) {
  app.use(schedule('1h', async () => {
    console.log('schedule started')
    await new Promise(() => undefined)
  }, { boot: true, lock: false }))
}

app.listen(0)
