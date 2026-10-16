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

With several server processes, `{ lock: 'weekly-report' }` runs the job once across all of them. With `lock` and several jobs, each job locks as `<lock>:<its schedule>:<its place in that schedule's list>`.

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

A failed job is kept 30 days, its payload included, or as long as `keepFailed` says. To erase a person's jobs, call `remove(match)`. It removes every waiting or failed job whose payload matches.

```ts
welcomeMails.remove(job => job.to === email)
```

Jobs wait in a SQLite file shared by the server processes on one machine. Under `bun test` they stay in memory, and `site.runJobs()` from `kay/test` runs them.

An idle queue looks for a job from one worker. A job another process enqueued waits 10 seconds at worst, the default `idlePoll`.

 A job enqueued in the same process still runs at once, and a retry is picked up when due.

Set `idlePoll: '1s'` to look every second, or `'30s'` to ask the database less often.

<ReadMore href="/llms/production#background-jobs">Job stores, concurrency, lost jobs and how shutdown waits for runs in progress are in the full production reference.</ReadMore>
