---
title: Background jobs
order: 8.5
description: Run work on a schedule, keep a worker running with the server, and queue jobs that survive a restart.
---

Three tools run work outside a request, each for its own kind of job.


| The job | Use |
| --- | --- |
| runs at set times or every so often, such as purging expired carts | [`schedule`](#scheduled-jobs) |
| runs as long as the server does, such as reading another service's queue | [`background`](#long-running-work) |
| is started by a request and must run even after a restart, retried when it fails, such as a welcome mail | [`queue`](#queues) |

## Scheduled jobs

`schedule(cron, job)` from `kay/server` is an Elysia plugin. The server runs the job from `.listen()` until it stops.

```ts
import { Elysia } from 'elysia'
import { pages, schedule } from 'kay/server'

new Elysia()
  .use(schedule('@hourly', purgeExpiredCarts))
  .use(schedule('30 2 * * MON', sendWeeklyReport, { tz: 'Europe/Paris' }))
  .use(schedule('30s', collectMetrics))
  .use(await pages())
  .listen(3000)
```

Pass several jobs in one call, as a list for one schedule or a table of schedules. `boot: true` also runs them once as the server starts.

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

A run that takes longer than `timeout`, 10 minutes by default, is logged as failed and left behind, so a job that never settles does not block the next run. A shutdown aborts the signal and waits at most 5 seconds for a run that ignores it.

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

A job that throws is retried after a growing wait. One that runs out of attempts is kept as failed and passed to `onFailed`. So is a run outlasting `lostAfter`, 10 minutes by default, or one whose process died each time.

The handler takes an `AbortSignal` as its second argument. It aborts when the run passes `lostAfter`, and when the server stops. A handler that passes it on, to `fetch` for example, stops by itself instead of running beside the retry, so a slow mail is not sent twice. A job stopped by a shutdown is handed back without losing an attempt, and another process takes it without waiting out `lostAfter`.

A failed job is kept 30 days, its payload included, or as long as `keepFailed` says. To erase a person's jobs, call `remove(match)`. It removes every waiting or failed job whose payload matches.

```ts
welcomeMails.remove(job => job.to === email)
```

The queue drops expired ones whenever you enqueue, list or remove jobs too, so a process with no worker still cleans up. `redact` gives what a failed job keeps instead of its payload, such as a mail without its body. `onFailed` still gets the whole payload, and a custom `JobStore` stores the redacted one only if its `fail` takes a third argument.

Jobs wait in a SQLite file shared by the server processes on one machine. Under `bun test` they stay in memory, and `site.runJobs()` from `kay/test` runs them.

An idle queue looks for a job from one worker. A job another process enqueued waits 10 seconds at worst, the default `idlePoll`.

 A job enqueued in the same process still runs at once, and a retry is picked up when due.

Set `idlePoll: '1s'` to look every second, or `'30s'` to ask the database less often.

### Your own store

`sqliteJobs` is the default store. To keep jobs in Redis or Postgres, pass `store` an object of `JobStore`, from `kay/server`. Every process of the app opens it, so it must hand each job to one process only.

To put the jobs, the schedule locks and the rate limit counts of the whole app in one place, set `store` in `kay.config.ts`: `store: sqliteData('data/app.sqlite')`, or `{ jobs, rates }` with a `JobStore` and a `RateStore` of your own. A queue, a schedule or a limit naming its own `store` keeps it.

| Method | Does |
| --- | --- |
| `add(job)` | Keeps a new job |
| `claim(queue, now, until)` | Takes the queue's next due job that no process holds, holding it until `until` |
| `complete(id)` | Removes a job that ran |
| `retry(id, runAt, error)` | Runs it again at `runAt` |
| `fail(id, error)` | Keeps it as failed, out of the queue |
| `failed(queue)` | Lists the failed jobs |
| `nextRunAt(queue)` | When the next job may run, so a worker sleeps until then |
| `lock(name, slot)` | True for the first caller of that name and slot, in any process, so a schedule runs once |

`purge(queue, before)`, `jobs(queue)` and `release(id, until)` are optional. `release` gives a claimed job back with its attempt not counted, which a shutdown does, only while `until`, the hold it was claimed with, is still the job's; without it, a job stopped by a shutdown is retried after its backoff. Without `purge`, old failed jobs are listed and removed one by one. Without `jobs`, `remove` works by id only.

```ts
export const welcomeMails = queue('welcome-mails', sendWelcome, { store: myStore })
```

<ReadMore href="/llms/production#background-jobs">Concurrency, lost jobs and how shutdown waits for runs in progress are in the full production reference.</ReadMore>
