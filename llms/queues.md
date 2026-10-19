# Queues

A `queue` runs jobs in the background, each surviving a restart; `schedule` and `background` are in [Running in production](production.md#background-jobs).

A queue holds jobs that must not be lost: an action enqueues one and goes on, and the server runs it in the background, after a restart or a deploy if need be:

```ts
// src/jobs.ts
import { queue } from 'kay/server'

export const welcomeMails = queue(
  'welcome-mails',
  async ({ to }: { to: string }) => sendWelcome(to),
  { attempts: 5, backoff: '30s' },
)
```

```ts
// src/server.ts
new Elysia().use(welcomeMails).use(await pages()).listen(3000)
```

- An action calls `await welcomeMails.enqueue({ to: email })`, or `enqueue(payload, { delay: '1h' })` to run it later.
- `queue(name, handler, options)` is an Elysia plugin: the server using it runs the queue's jobs from start to stop, `concurrency` at a time, 1 by default, and waits on stop for the runs in progress.
- A process that only enqueues, a script say, need not use it.
- Jobs wait in a store shared by every process of the machine opening it: `sqliteJobs('data/jobs.sqlite')` by default, its file and directory created by the first job enqueued or schedule locked, which every schedule of a production server does by default, so its `data/` must be writable there; a dev or test server whose queues never get a job writes nothing.
- `sqliteJobs(path)` and `memoryJobs()` from `kay/server` make a `store` of another file or one kept in the process, and `JobStore` is the shape of an app's own.
- A `JobStore` may also have `state(queue, ref, now)`, `progress(id, until, progress)` and `release(id, until, runAt?)`, and its `add(job)` may resolve with the id of the live job already holding `job.key`, in which case it stored nothing: `sqliteJobs` and `memoryJobs` do all of these. A file made by an older kay gains the columns on first open.
- `store` in kay.config.ts is the one store of the app, `import { sqliteData } from 'kay/server'` then `store: sqliteData('data/app.sqlite')`, which keeps the jobs of every queue and locked schedule that names no `store`, and the counts of every rate limit that names none, in one SQLite file, so replicas sharing it count together. `store: { jobs, rates }` takes a `JobStore` and a `RateStore` of your own, each optional, Redis say. A `store` on a queue, a schedule or a limit wins, the proof-of-work solutions already used count there too, a `store.rates` needs `peek` for a limit counting only the posts that went through, and a `bun test` site keeps both in memory.
- Under `bun test` the default is in memory.
- Each job runs in one process.
- The payload goes through devalue, as cached values do: dates, maps and sets survive, a function or a class instance throws from `enqueue`.
- A run that throws is retried: `backoff` after the first failure, 10 seconds by default, twice as long after each next one, until `attempts` runs in all, 5 by default, each failure retried logged as a one-line warning with its attempt, its wait and the error's message.
- The last failure keeps the job as failed, logs it with its stack and hands its payload and error to `onFailed`; `failed()` lists the failed jobs.
- A failed job is kept 30 days from when its last attempt was due, payload included, then dropped by the workers, and by any `enqueue`, `failed()` or `remove()` of the queue in a process running none; `keepFailed` sets another duration, or `false` to keep it until removed. `redact(payload)` gives what a job keeps in place of its payload once it is given up, such as a mail without its body; `onFailed` still gets the whole payload. A custom `JobStore.fail(id, error, payload?)` stores that payload, and a store ignoring it keeps the job whole.
- `remove(id)` removes a job, and `remove(match)` every waiting or failed job whose payload `match` returns true for, such as a person's mails once they asked to be erased, resolving with how many went; an app's own `JobStore` takes a function only when it has `jobs(queue)`.
- An idle queue looks at the store from one worker, which is how a job another process enqueued is noticed: 1 second after a job, then twice as long after each empty look up to `idlePoll`, 10 seconds by default, so such a job waits 10 seconds at worst. A job enqueued in this process, or delayed to a time the store knows, still runs at once, and a retry is picked up when due. `idlePoll: '1s'` looks every second as the queue did before 1.45, `'30s'` asks the database less often; it takes at least `1s`. A custom `JobStore` may have `purge(queue, before)` to drop the expired failed jobs in one call.
- A store that fails, a SQLite file locked past its timeout say, is logged once as the outage starts and once as it ends, its workers asking it again later and later meanwhile, up to a minute apart.
- A handler takes `(payload, signal)`: the `AbortSignal` aborts at `lostAfter`, so a handler passing it on stops instead of running beside the retry, and as the server stops, when a job it gives up on is released with `release(id, until)` of the `JobStore`, clearing the hold only while `until`, the one it was claimed with, is still the job's (optional): back without waiting out `lostAfter`, its attempt not counted, instead of held until `lostAfter` and retried after its backoff. Without `release` the job is retried as before.
- A process that dies running a job leaves it held: it runs again once `lostAfter` has passed since it started, 10 minutes by default. A run still going as `lostAfter` ends counts as a failed attempt, so its worker moves on, its handler's signal aborted, so a handler ignoring it runs on beside the retry, and a job longer than `lostAfter` needs a longer one, and a job whose process died during each of its `attempts` is kept as failed without running again, rather than crash every process that takes it.
- `drain()` runs every job whose time has come, here and now, until none is left; in tests `site.runJobs()` from `kay/test` does it for every queue.
