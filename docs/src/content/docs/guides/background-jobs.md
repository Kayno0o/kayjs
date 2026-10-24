---
title: Background jobs
order: 8.5
description: Run work on a schedule, keep a worker running with the server, and queue jobs that survive a restart.
---

Four tools run work outside a request, each for its own kind of job.


| The job | Use |
| --- | --- |
| runs at set times or every so often, such as purging expired carts | [`schedule`](#scheduled-jobs) |
| runs as long as the server does, such as reading another service's queue | [`background`](#long-running-work) |
| is started by a request and must run even after a restart, retried when it fails, such as a welcome mail | [`queue`](#queues) |
| is a flow of steps that waits days or for an event, such as a mail, a three-day wait, then a reminder | [`workflow`](#workflows) |

## Scheduled jobs

`schedule(cron, job)` from `kay/server` is an Elysia plugin. The server runs the job from the server listening until it stops.

```ts
import { Elysia } from 'elysia'
import { pages, schedule } from 'kay/server'

new Elysia()
  .use(schedule('@hourly', purgeExpiredCarts))
  .use(schedule('30 2 * * MON', sendWeeklyReport, { tz: 'Europe/Paris' }))
  .use(schedule('30s', collectMetrics))
  .use(await pages())
```

Pass several jobs in one call, as a list for one schedule or a table of schedules. `boot: true` also runs them once as the server starts. Servers starting within the same minute usually run it once, and a restart later runs it again.

```ts
app.use(schedule({
  '* * * * *': [collectTraffic, checkSites],
  '12 * * * *': checkCertificates,
  '30s': collectMetrics,
}, { boot: true }))
```

A cron has five fields or a nickname such as `@daily`. A cron that can never run, such as `0 0 30 2 *`, is a type error. A length such as `'30s'` or `'1h'` runs at each multiple of it. `tz` applies to the crons and not to the lengths.

Runs never overlap. A run that throws is logged without stopping the next.

A production server (`NODE_ENV=production`) runs each schedule once across all its processes sharing the job store, with no setup: the lock is named after the schedule and the job's source, so the job store should be writable. If it cannot give that lock, kay logs one warning and runs the job in every process, where a `lock` you named skips the run.

In a rolling deploy, old and new builds with a changed job both run, as their locks differ. `{ lock: 'weekly-report' }` names it yourself, and `{ lock: false }` runs the job in every process. With `lock` and several jobs, each job locks as `<lock>:<its schedule>:<its place in that schedule's list>`.

A run that takes longer than `timeout`, 10 minutes by default, is logged as failed and left behind, so a job that never settles does not block the next run. A shutdown aborts the signal and waits at most 3 seconds, less with a short `shutdownTimeout`, for a run that ignores it.

The job is called with the signal, so a job with an optional first parameter gets it. The job gets an `AbortSignal` as its argument, aborted at the timeout and when the server stops; `timeout: false` sets no limit.

A boot run happens wherever the server starts, so also at each restart of `kay dev`.

## Long-running work

`background(work)` starts work with the server and keeps it running, such as a consumer reading another service's queue. On shutdown its signal aborts, and the server waits for it to return. Work that throws is logged and not started again.

```ts
import { background } from 'kay/server'

app.use(background(async (signal) => {
  while (!signal.aborted)
    await handleNextEmail(signal)
}))
```

## Queues

A queue holds jobs that must not be lost. An action enqueues one and answers at once. The server runs the job after the response, or after a restart or a deploy if it has to.

```ts
// src/jobs.ts
import { queue } from 'kay/server'

export const welcomeMails = queue(
  'welcome-mails',
  async ({ to }: { to: string }) => sendWelcome(to),
  { attempts: 5, backoff: '30s', onFailed: reportFailedMail },
)
```

The server runs it with `.use(welcomeMails)`. An action calls `await welcomeMails.enqueue({ to: email })`, or `enqueue(payload, { delay: '1h' })` to run it later.

A job that throws is retried after a growing wait. One that runs out of attempts is kept as failed and passed to `onFailed` as `{ payload, error }`. So is a run outlasting `lostAfter`, 10 minutes by default, or one whose process died each time.

Under `kay dev`, the dev tool's Jobs tab lists every queue's jobs and retries or deletes a failed one ([the dev tool](/guides/performance/#jobs)).

A workflow run shows as its state, running, sleeping until a time, waiting for an event or failed, with its last steps, and buttons to send the event it waits for (without data) or cancel it.

In production, `jobs: { guard }` in `kay.config.ts` serves that list at `/_kay/jobs`, behind the guard you give it: `jobs: { guard: ctx => ctx.locals.auth.requireAdmin() }` with kayjs-auth, or any guard. Without a guard the server does not start, and `jobs: { guard, path }` moves the page.

Some failures are nobody's fault: a full disk, a service asking you to slow down. To try again later without spending an attempt, throw `retryLater` with how long to wait.

```ts
import { queue, retryLater } from 'kay/server'

export const downloads = queue('downloads', async (url: string) => {
  if (await diskIsFull())
    throw retryLater('30s')
  await download(url)
}, { attempts: 3 })
```

The job comes back after the wait, as often as the handler throws it, and is never kept as failed for it. A handler that should give up throws an error of its own, which spends attempts as ever.

### Progress

A handler takes the job as its third argument. `job.progress(value)` reports how far the run is, and `job(key)` on the queue reads it back while the job runs.

```ts
export const sync = queue<{ provider: string }, { processed: number, total: number }>(
  'sync',
  async ({ provider }, signal, job) => {
    const items = await list(provider)

    for (const [index, item] of items.entries()) {
      await store(item, signal)
      job.progress({ processed: index + 1, total: items.length })
    }
  },
)
```

Reports go to the store in the background, the latest one winning, so reporting for every item costs little. The second type argument types the value. It is kept as the payload is, so a date or a map survives.

A page learns it through an action, which decides who may see it. An island calls the action every few seconds and shows `status` and `progress`.

```ts
export const syncState = action(async () => sync.job('anilist'))
```

A failed job keeps the last value it reported. The next run of a retried job starts with none. A report made after the run ended is dropped.

The handler takes an `AbortSignal` as its second argument. It aborts when the run passes `lostAfter`, and when the server stops. A handler that passes it on, to `fetch` for example, stops by itself instead of running beside the retry, so a slow mail is not sent twice. A job stopped by a shutdown is handed back without losing an attempt, and another process takes it without waiting out `lostAfter`.

A queue made with `lazy: true` starts no worker with the server. The first `enqueue`, or a call to `activate()`, starts it. Use it for a queue an app may never need, so it costs no idle poll.

A failed job is kept 30 days, its payload included, or as long as `keepFailed` says. To erase a person's jobs, call `remove(match)`. It removes every waiting or failed job whose payload matches.

```ts
welcomeMails.remove(job => job.to === email)
```

To keep less of a failed job, name what it keeps in `redact`:

```ts
export const welcomeMails = queue('welcome-mails', sendWelcome, {
  redact: ({ to }) => ({ to }),
})
```

The queue drops expired ones whenever you enqueue, list or remove jobs too, so a process with no worker still cleans up. `redact` gives what a failed job keeps instead of its payload, such as a mail without its body. `onFailed` still gets the whole payload, and a custom `JobStore` stores the redacted one only if its `fail` takes a third argument.

To run a job once however often it is asked for, give `enqueue` a `key`. While a job with that key is waiting or running, `enqueue` stores nothing and resolves with that job's id.

```ts
await sync.enqueue({ provider: 'anilist' }, { key: 'anilist' })
```

Once the job completes, or is kept as failed, the key is free again. `await sync.job('anilist')` tells where the job stands: `{ id, status, attempts }` with `status` `'waiting'`, `'running'` or `'failed'`, and `error` after a failed run. It is `undefined` once the job completed.

A job enqueued while the one with its key runs is dropped, even if its data is newer than what that run read. To run again after it, enqueue without a key, or once it completed.

Jobs wait in a SQLite file shared by the server processes on one machine. Under `bun test` they stay in memory, and `site.runJobs()` from `kay/test` runs them. It also waits for a job a worker already started, so the test sees what that job did. A `queue.enqueue()` your action started without awaiting is waited for too; one a timer has not started yet is not.

An idle queue looks for a job from one worker. A job another process enqueued waits 10 seconds at worst, the default `idlePoll`.

 A job enqueued in the same process still runs at once, and a retry is picked up when due.

Set `idlePoll: '1s'` to look every second, or `'30s'` to ask the database less often.

### Postgres

`pgJobs(db)` keeps the jobs in Postgres. It takes a Bun `SQL`, a pg-orm `Database` or a connection URL.

If your app uses pg-orm, list the queue's tables with your own. Then `db.sync()` or `pg-orm generate` creates them, and your migrations carry them to production like any other table.

```ts
import { Database } from '@kaynooo/pg-orm'
import { jobTables } from 'kay/pg-orm'

export const db = new Database({ url: env.DATABASE_URL, tables: [...tables, ...jobTables] })
```

kay lists pg-orm as an optional peer, so an app without it installs and builds as before. The app template connects with `app_rw`, which may not create tables. That is fine, because the migration, run by the owner, already created them.

Without pg-orm migrations, `pgJobs` creates the tables when they are missing and its role may. If the role may not, the owner creates them once, in a boot script, with `await createJobTables(db)`. It is safe to run again, and from several replicas at once.

When an index is missing, one replica builds it and the others wait until the unique ones are valid before they go on. That lock is a Postgres session lock, so run it on a direct or session-mode connection, not behind a transaction-mode pooler such as pgbouncer's. pg-orm does not know tables made that way, so tell it to leave them alone with `ignoreTables: [...jobTables]`, where `jobTables` comes from `kay/server` and lists their names.

A claim and its hold use the database's clock, so replicas need not keep their clocks in agreement.

#### The whole app store on Postgres

`pgData(db)` is `sqliteData` on Postgres. It keeps the sessions, the cached values, the jobs, the schedule locks, the rate limit counts, the members of presence rooms, the live values and the Web Vitals in `kay_*` tables of the same database, so replicas on several machines share them.

```ts
import { defineConfig, pgData } from 'kay/server'

export default defineConfig({
  store: pgData(env.DATABASE_URL),
})
```

It takes what `pgJobs` takes, and creates its tables when they are missing and its role may. If the role may not, the owner runs `await createDataTables(db)` once in a boot script, and pg-orm's `ignoreTables` lists `dataTables` from `kay/server`.

Replicas learn of each other's invalidations, live values and room messages by polling, within about half a second (5 seconds on an idle server), so nothing needs LISTEN and a pooler in front of Postgres works, except for building a missing index, which needs a session connection.

A database belongs to one app. The first app to start on it records its `package.json` name, and a different app starting on the same database stops with an error naming both, because they would otherwise share queues, cached values, live values and rooms. Give each app a database of its own. If you renamed the app, start it once with `KAY_ADOPT_DATABASE=<old name>` to take the database over.

Two apps with the same `package.json` name count as one, and `pgJobs(db)` used on its own, without `pgData`, claims nothing. A database made before this check belongs to the first app that starts on it.

A store you open yourself, in a script or a test, is closed with `await store.close()`, or by `await using store = pgData(url)`. That stops its polling and timers, takes this process out of the presence rooms and closes the pool when you gave a URL. A connection you passed in stays open, since it is yours to close. A `kay dev` reload closes the store of the module that ran again by itself.

A server reads the live values when it starts; `kay build --static` and `kay check` read none. A room shares its members and messages, which reach the other replicas in the order one published them, and `rooms({ store: pgData(db).rooms, state })` keeps its state there too, with `state` and `update` giving promises.

If the database stops answering, a call of any of these stores fails after 8 seconds (150 for the sweeps and the calls that scan a table) with a logged error instead of hanging, so a worker backs off, a stop is not held up and a request reading a session fails rather than waits. A connection kay opens from a URL times out connecting after 10 seconds, closes when idle for 60 and is replaced after 30 minutes.

### Your own store

`sqliteJobs` is the default store, one file shared by the processes of a machine. For replicas on several machines, `pgJobs(db)` keeps the jobs in Postgres: pass it a Bun `SQL`, a pg-orm `Database` or a connection URL. To keep jobs elsewhere, Redis say, pass `store` an object of `JobStore`, from `kay/server`. Every process of the app opens it, so it must hand each job to one process only.

To put the sessions, the cached and live values, the jobs, the schedule locks, the rate limit counts and the members of presence rooms and the Web Vitals of the whole app in one place, set `store` in `kay.config.ts`: `store: sqliteData('data/app.sqlite')`, or `{ sessions, cache, live, jobs, rates, rooms, vitals, notifications }` with stores of your own. A session, a `cached` call, a queue, a schedule or a limit naming its own `store` keeps it.

| Method | Does |
| --- | --- |
| `add(job)` | Keeps a new job |
| `claim(queue, now, until)` | Takes the queue's next due job that no process holds, holding it until `until`, and returns the hold it stored as `heldUntil` when it keeps time of its own |
| `complete(id, until?)` | Removes a job that ran |
| `retry(id, runAt, error, until?)` | Runs it again at `runAt` |
| `fail(id, error, payload?, until?)` | Keeps it as failed, out of the queue |
| `failed(queue)` | Lists the failed jobs |
| `nextRunAt(queue)` | When the next job may run, so a worker sleeps until then |
| `lock(name, slot)` | True for the first caller of that name and slot, in any process, so a schedule runs once |

`purge(queue, before)`, `jobs(queue)`, `revive(id, runAt)`, `release(id, until, runAt?)`, `progress(id, until, progress)` and `state(queue, ref, now)` are optional. Without `purge`, old failed jobs are listed and removed one by one. Without `jobs`, `remove` works by id only.

`jobs` and `failed` may take a limit (and `jobs` a `failed` flag) to cut their result in the query: the dev tool and the jobs page ask for 101 jobs of each kind, so a long queue is never read whole, and a store that ignores it is cut after.

`complete`, `retry` and `fail` get the hold the job was claimed with as `until` and change the job only while it is still the job's, so a run that finishes after its hold ended and another process took the job changes nothing. A store that ignores `until` keeps working, without that guard. `remove` and the purge call `complete` without it.

`release` gives a claimed job back with its attempt not counted, which a shutdown does, and due at `runAt` when given. It works only while `until`, the hold the job was claimed with, is still the job's. Without it, a job stopped by a shutdown is retried after its backoff.

`progress` stores what a run reports, again only while `until` is the job's, and the next claim clears it. `state` finds the waiting or running job with a key or an id, else its last failed one. `revive` puts a failed job back to wait with its attempts given back, and resolves with whether it did: the dev tool's Jobs tab retries a failed job with it, and without it the button is off.

`add` takes a job's optional `key`. When a waiting or running job of the queue has it, a store with `state` keeps nothing and resolves with that job's id.

```ts
export const welcomeMails = queue('welcome-mails', sendWelcome, { store: myStore })
```

<ReadMore href="/llms/queues">Concurrency, lost jobs and how shutdown waits for runs in progress are in the queues reference.</ReadMore>

## Workflows

A `workflow` is a flow of steps that survives restarts, sleeps for days without holding a process and waits for an event. `step.run` runs a step once and keeps its result, `step.sleep` lets the run go for a while, and `step.waitFor` waits for an event.

```ts
// src/jobs.ts
import { workflow } from 'kay/server'

export const onboarding = workflow<{ userId: string }, { visited: undefined }>('onboarding', async ({ input, step }) => {
  await step.run('welcome', () => sendWelcome(input.userId))

  const visit = await step.waitFor('visited', { timeout: '3d' })

  if (visit.timedOut)
    await step.run('reminder', () => sendReminder(input.userId))
})
```

Use it like a queue: `.use(onboarding)` before `pages()` in `src/server.ts`, or `export { onboarding as default } from '../jobs'` in `src/plugins/jobs.ts`. An action starts a run with one call and sends it an event with another. The `id` names the run, so an app can use its own, a user's id say.

```ts
await onboarding.start({ userId }, { id: userId })
await onboarding.send(userId, 'visited')
```

The run is a job of the queue `workflow:onboarding` in the same store as your queues: memory, SQLite or Postgres, shared by every process. Its results are kept in that job after each step, so after a restart the run goes on at the first step with no result. A stop hands the run back at once. A process that died holds it until `lostAfter`, 10 minutes by default.

The function runs again from its top each time the run is taken, and a finished step returns its kept result, so what lies between steps must give the same answer every time. Await each step before the next. Renaming or reordering steps under a run that is waiting fails that run at once, with an error naming the step. Results go through devalue, as a queue's payload does.

`step.sleep('3d')` and `step.waitFor` hold no process: the run waits in the store and the code after them runs in whichever process takes the run. `waitFor(event)` resolves with the event's data. With a `timeout` it resolves with `{ timedOut: false, data }` or `{ timedOut: true }`.

`send(id, event, data)` resolves with whether the run took the event. A run that is not waiting for it yet keeps it for the wait that names it, so `start` followed by `send` works. It keeps 50 such events, dropping and logging the oldest. An event sent while a step is running is dropped. `status(id)` tells whether a run is `running`, `sleeping`, `waiting` or `failed`, and `cancel(id)` ends it.

A step that throws is retried with the queue's `attempts` and `backoff`, and the steps done before it do not run again. A step finishing starts the count of attempts again. A stop ends the run before its next step starts, so the process taking over never runs a step beside the first.

The options are those of a queue: `store`, `attempts`, `backoff`, `concurrency`, `lostAfter`, `idlePoll` and `keepFailed`, and `onFailed` gets `{ id, input, error }`. `lostAfter` bounds the time between two sleeps or waits. A custom job store needs `update`, `release` and `state`.

The job holds the input and every kept result, so keep results small and free of secrets: a failed run keeps them for 30 days, and the jobs page shows them.

In tests, `runJobs()` runs the due steps and `setSystemTime` moves a sleep or a timeout along.

<ReadMore href="/llms/queues">The store contract of `update` and the details of runs are in the queues reference.</ReadMore>
