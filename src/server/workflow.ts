import type { Elysia } from 'elysia'
import type { ErrorShape } from '../runtime/api-error'
import type { Duration } from '../runtime/duration'
import type { Hook } from './hooks'
import type { JobContext, JobStore, QueueOptions, RunHold } from './queue'
import { parse, stringify } from 'devalue'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { defaultJobStore, GiveUpError, jobQueue } from './queue'

type Events = Record<string, unknown>

// What a wait with a timeout resolves with: `{ ok: true, data }`, or `{ ok: false, error }` when the timeout came first, as every result discriminates.
// `timedOut` is `!ok`, kept beside it for the code that reads it: read `ok`.
export type WaitResult<Data>
  = | { ok: true, timedOut: false, data: Data, error?: undefined }
    | { ok: false, timedOut: true, error: ErrorShape, data?: undefined }

// The memo keeps the wait as it was first written, `{ timedOut, data? }`, so a run kept before `ok` existed replays; the result an app reads is made from it.
type WaitMemo = { timedOut: false, data: unknown } | { timedOut: true, data?: undefined }

function waited(event: string, kept: WaitMemo): WaitResult<unknown> {
  return kept.timedOut
    ? { ok: false, timedOut: true, error: { status: 408, message: `waitFor('${event}') timed out`, errors: {}, data: undefined } }
    : { ok: true, timedOut: false, data: kept.data }
}

export interface WorkflowStep<Known extends Events> {
  // Runs `work` for the run and keeps its result, a value devalue keeps, in the store: a restart or a retry gets the kept result back instead of running it again. That is at least once, not exactly once: a crash between the side effect and the write of its result runs `work` again, so give a charge or a mail the `key` of the step, the same on every run of it (the run's id and the step's place), as its idempotency key. Steps run one at a time, each awaited before the next.
  run: <Result>(name: string, work: (signal: AbortSignal, step: { key: string }) => Result | Promise<Result>) => Promise<Awaited<Result>>
  // Lets the run go for `wait`: nothing holds a process meanwhile, and the code after it runs once the time comes, in whichever process takes the run.
  sleep: (wait: Duration) => Promise<void>
  // Waits for `send(id, event, data)` to this run and resolves with its data; with a `timeout`, resolves with `{ ok: false, error }` when the time comes first.
  waitFor: {
    <Event extends keyof Known & string>(event: Event): Promise<Known[Event]>
    <Event extends keyof Known & string>(event: Event, options: { timeout: Duration }): Promise<WaitResult<Known[Event]>>
  }
}

export interface WorkflowRun<Input, Known extends Events> {
  // The run's id: the `key` it started with, else one made for it.
  id: string
  input: Input
  step: WorkflowStep<Known>
}

export interface WorkflowOptions<Input> extends Pick<QueueOptions<never>, 'store' | 'attempts' | 'backoff' | 'concurrency' | 'lostAfter' | 'idlePoll' | 'failedTtl'> {
  // Told once, when a worker first takes the run: not for the runs after a sleep, a wait or a retry.
  onStart?: Hook<{ id: string, input: Input }> | undefined
  // Told once the flow function ended, after its last step.
  onSuccess?: Hook<{ id: string, input: Input }> | undefined
  // Told when an attempt failed and the run is taken again after `wait` ms.
  onRetry?: Hook<{ id: string, input: Input, attempts: number, error: unknown, wait: number }> | undefined
  // Told when the last attempt failed, once the run is kept as failed.
  onError?: Hook<{ id: string, input: Input, attempts: number, error: unknown }> | undefined
}

export interface StartOptions {
  // Names the run, as `key` of `enqueue()` names a job: while a run with this key is live (waiting, sleeping or running), starting it again starts nothing and resolves with the same id, the key itself. `send`, `status` and `cancel` take it, so a user's key here is all an app keeps. A random id otherwise.
  key?: string | undefined
  /** @deprecated The old name of `key`, which wins when both are given. Removed in 1.102.0; `deprecated-workflow-start-id` rewrites it. */
  id?: string | undefined
  // Starts the run this long from now.
  delay?: Duration | undefined
}

export interface WorkflowStatus {
  // `waiting` for an event, `sleeping` until a time or for a worker to take the run, `running` while a process holds it, `failed` once given up.
  status: 'running' | 'sleeping' | 'waiting' | 'failed'
  // How many steps are done.
  steps: number
  // The event a `waiting` run waits for.
  event?: string
  error?: string
}

export type Workflow<Input, Known extends Events> = Elysia & {
  // Starts a run, which the server's workers carry out, surviving restarts; resolves with its id once stored.
  start: (...args: undefined extends Input ? [input?: Input, options?: StartOptions] : [input: Input, options?: StartOptions]) => Promise<string>
  // Hands the event to the run, waking it now when it waits for it, else keeping it for the wait that names it; resolves with whether the run took it. An event sent while a step runs, or once a worker took the run after its timeout, is dropped.
  send: <Event extends keyof Known & string>(id: string, event: Event, ...data: undefined extends Known[Event] ? [data?: Known[Event]] : [data: Known[Event]]) => Promise<boolean>
  // Where the run stands; undefined once it completed, was cancelled or never started.
  status: (id: string) => Promise<WorkflowStatus | undefined>
  // Ends a run: one not running goes at once, one running stops at its next step. Resolves with whether there was one.
  cancel: (id: string) => Promise<boolean>
  // Runs every run whose time has come, here and now, as `drain` of a queue does.
  drain: () => Promise<number>
}

interface Entry {
  kind: 'run' | 'sleep' | 'wait'
  name: string
  value: unknown
}

interface Payload<Input> {
  run: string
  input: Input
  // The kept steps of a run kept before steps had rows of their own, and `[]` of one just started: a store with `steps` moves them to rows the first time it keeps the run, and a store without it keeps them here.
  memo?: Entry[] | undefined
  // The run's steps as rows of the store hold them: how many, how many characters in all, and the labels of the last ones.
  kept?: { count: number, bytes: number, last: string[] } | undefined
  // Events sent before the run waited for them, taken in order by the waits that name them.
  inbox?: { event: string, data: unknown }[] | undefined
  // Set while the run waits for an event, until its timeout.
  waiting?: { event: string, index: number } | undefined
  // Set once the run was kept for a sleep or a wait, so a run taken again is not told as started.
  started?: true | undefined
}

const noop = () => undefined
const RELEASE_TRIES = 3

// Events kept for a wait that does not name them yet, per run: past it the oldest is dropped.
export const INBOX_LIMIT = 50

// The most characters a run's input, events and kept results may take in all, which a worker reads whole each time it takes the run: a run past this fails, as one that has to keep large results elsewhere and return their ids.
export const PAYLOAD_LIMIT = 2_000_000

function withinLimit(size: number, name: string, run: string, steps: number): void {
  if (size > PAYLOAD_LIMIT)
    throw new GiveUpError(`kay: workflow('${name}') run '${run}' keeps ${Math.round(size / 1000)} KB of input, events and results after ${steps} steps, past the ${PAYLOAD_LIMIT / 1000} KB a run may keep: return an id from a step that makes a large result and keep the result elsewhere, or split a long loop into runs`)
}

// A wait without timeout is due never: the last instant a Date holds.
export const NEVER = 8.64e15

// What the dev tool and the jobs page show of a run: where it stands and the steps it has kept, as `run <name>`, `sleep` and `wait <event>`.
export interface RunView {
  state: WorkflowStatus['status']
  // The event a `waiting` run waits for.
  event?: string
  // When a `sleeping` run or a `waiting` one with a timeout is due.
  until?: number
  // How many steps are kept.
  done: number
  // The names of the last ones, at most STEP_NAMES, each cut.
  steps: string[]
}

const STEP_NAMES = 20
const NAME_CHARS = 100

const labelOf = (entry: Entry) => entry.kind === 'sleep' ? 'sleep' : `${entry.kind} ${entry.name}`.slice(0, NAME_CHARS)
const stepsDone = (payload: Payload<unknown>) => payload.kept?.count ?? payload.memo?.length ?? 0

export const WORKFLOW_PREFIX = 'workflow:'

// What a queue job of `workflow:<name>` is, read from its stored payload; undefined when the payload is not a run's.
export function runView(status: 'waiting' | 'running' | 'failed', payloadText: string, runAt: number): RunView | undefined {
  let payload: Payload<unknown>

  try {
    payload = parse(payloadText) as Payload<unknown>
  }
  catch {
    return undefined
  }

  const { memo, kept } = payload ?? {}
  const shaped = kept === undefined
    ? Array.isArray(memo) && memo.every(entry => typeof entry?.kind === 'string' && typeof entry.name === 'string')
    : typeof kept?.count === 'number' && Array.isArray(kept.last) && kept.last.every(label => typeof label === 'string')

  if (!shaped || (payload.waiting !== undefined && typeof payload.waiting.event !== 'string'))
    return undefined

  const steps = kept === undefined ? memo!.slice(-STEP_NAMES).map(labelOf) : kept.last
  const done = stepsDone(payload)
  const until = runAt < NEVER ? { until: runAt } : {}

  if (status === 'waiting' && payload.waiting)
    return { state: 'waiting', event: payload.waiting.event, ...until, done, steps }

  return { state: status === 'waiting' ? 'sleeping' : status, ...status === 'waiting' && until, done, steps }
}

// What the dev tool and the jobs page act on a run with, by the name of its queue.
export interface WorkflowAdmin {
  // Only applies while the run waits for that very event, else it resolves with false and keeps nothing.
  send: (id: string, event: string, data?: unknown) => Promise<boolean>
  // Ends the run held by that job of the queue.
  cancel: (jobId: string) => Promise<void>
}

function needs(store: JobStore, name: string): { [Method in 'update' | 'release' | 'state']-?: NonNullable<JobStore[Method]> } {
  const { update, release, state } = store

  if (!update || !release || !state)
    throw new KayError('config-invalid', `kay: workflow('${name}')'s store has no update(), release() and state(): add them to the JobStore, or use sqliteJobs, memoryJobs or pgJobs`)

  return { update: update.bind(store), release: release.bind(store), state: state.bind(store) }
}

// A store that fails to release the run would have the queue retry it, moving its due time: ask again first.
async function releasing(release: NonNullable<JobStore['release']>, id: string, until: number): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await release(id, until)

      return
    }
    catch (error) {
      if (tries === RELEASE_TRIES)
        throw error

      await Bun.sleep(100 * tries)
    }
  }
}

// The write that keeps a run after a step: the payload and, with `rows` (how many steps and characters the store has as rows), the steps it lacks; without them, the payload with all steps in it.
function keptChange<Input>(name: string, head: Payload<Input>, memo: Entry[], rows: { stored: number, bytes: number } | undefined, runAt: number | undefined) {
  if (rows === undefined) {
    const text = stringify({ ...head, memo })

    withinLimit(text.length, name, head.run, memo.length)

    return { change: { payload: text, runAt }, size: 0 }
  }

  const values = memo.slice(rows.stored).map(entry => stringify(entry))
  const size = rows.bytes + values.reduce((sum, text) => sum + text.length, 0)

  const payload = stringify({ ...head, kept: { count: memo.length, bytes: size, last: memo.slice(-STEP_NAMES).map(labelOf) } })

  // The input and the events no wait named count with the results, as a worker reads them all each time it takes the run.
  withinLimit(size + payload.length, name, head.run, memo.length)

  return { change: { payload, runAt, steps: { from: rows.stored, values } }, size }
}

// What an event wakes a waiting run with: its result added as a step, a row of its own on a store that keeps them, moving a run kept in the old shape to rows with it, else a member of the payload's list.
function woke(store: JobStore, payload: Payload<unknown>, entry: Entry, runAt: number): Parameters<NonNullable<JobStore['update']>>[1] {
  const { memo, kept, ...rest } = payload

  if (store.steps === undefined)
    return { payload: stringify({ ...rest, memo: [...memo ?? [], entry], waiting: undefined }), runAt }

  const added = [...memo ?? [], entry]
  const values = added.map(item => stringify(item))
  const count = (kept?.count ?? 0) + added.length

  return {
    payload: stringify({ ...rest, kept: { count, bytes: (kept?.bytes ?? 0) + values.reduce((sum, text) => sum + text.length, 0), last: [...kept?.last ?? [], ...added.map(labelOf)].slice(-STEP_NAMES) }, waiting: undefined }),
    runAt,
    steps: { from: kept?.count ?? 0, values },
  }
}

// A flow of steps that survives restarts, sleeps without holding a process and waits for events: `start` it from an action, `app.use(flow)` in the server to run it, `send` it an event.
// The function runs again from its top each time the run is taken, and each finished step gives its kept result back, so what lies between steps must give the same answer every time. The run is one job of the queue `workflow:<name>` kept under its id, and its results are kept in that job after each step.
export function workflow<Input = undefined, Known extends Events = Events>(name: string, flow: (run: WorkflowRun<Input, Known>) => unknown, options: WorkflowOptions<Input> = {}): Workflow<Input, Known> {
  const queueName = `${WORKFLOW_PREFIX}${name}`
  const { onStart, onSuccess, onRetry, onError, store: own, ...rest } = options
  const storeOf = () => own ?? defaultJobStore()

  const handler = async (payload: Payload<Input>, signal: AbortSignal, job: JobContext<unknown>, hold: RunHold) => {
    const store = storeOf()
    const { update, release } = needs(store, name)
    const { until } = hold
    // With a store that has `steps`, each step is written once as a row of its own, so a step costs what its result does whatever the run's length; one without keeps them all in the payload.
    const rows = store.steps === undefined ? undefined : await store.steps(job.id)
    const memo = [...payload.memo ?? [], ...rows?.map(text => parse(text) as Entry) ?? []]
    // How many of them the store has as rows, and how many characters those take.
    let stored = rows?.length ?? 0
    let bytes = payload.kept?.bytes ?? 0
    const inbox = [...payload.inbox ?? []]
    let at = 0
    let busy = false
    let halted = false
    const ended = Promise.withResolvers<void>()

    // Ends the claim without the code after the step running: the step's promise never settles, so a `try` around it catches nothing.
    const halt = async (): Promise<never> => {
      halted = true
      hold.handBack()
      ended.resolve()

      return new Promise<never>(noop)
    }

    // A kept step starts the attempts again, as the store does for the stored count.
    const keep = async (waiting?: Payload<Input>['waiting'], runAt?: number) => {
      const { change, size } = keptChange(name, { run: payload.run, input: payload.input, inbox, waiting, started: true }, memo, rows === undefined ? undefined : { stored, bytes }, runAt)
      const kept = await update(job.id, change, { until })

      if (kept) {
        job.attempts = 1
        stored = memo.length
        bytes = size
      }

      return kept
    }

    // A write refused means the run was cancelled or went to another process: nothing more of it is ours to do.
    const suspend = async (waiting?: Payload<Input>['waiting'], runAt?: number): Promise<never> => {
      if (await keep(waiting, runAt))
        await releasing(release, job.id, until)

      return halt()
    }

    const enter = (kind: Entry['kind'], label: string) => {
      // A stop or a lost hold ended the claim: no side effect of the next step may run beside whoever takes the run.
      signal.throwIfAborted()

      if (busy)
        throw new Error(`kay: workflow('${name}') ran two steps at once: await each step before starting the next`)

      const slot = at++
      const seen = memo[slot]

      if (seen && (seen.kind !== kind || seen.name !== label))
        throw new GiveUpError(`kay: workflow('${name}') changed under a run: its step ${slot + 1} was ${seen.kind === 'run' ? `'${seen.name}'` : seen.kind}, now ${kind === 'run' ? `'${label}'` : kind}; finish or cancel the runs started before such a change`)

      return { slot, seen }
    }

    const step: WorkflowStep<Known> = {
      async run(label, work) {
        const { slot, seen } = enter('run', label)

        if (seen)
          return seen.value as never

        busy = true

        try {
          const value = await work(signal, { key: `${payload.run}:${slot + 1}` })

          memo.push({ kind: 'run', name: label, value })

          try {
            stringify(value)
          }
          catch (error) {
            throw new Error(`kay: step '${label}' of workflow('${name}') returned a value devalue cannot keep: ${error instanceof Error ? error.message : String(error)}`)
          }

          return await keep() ? value : await halt()
        }
        finally {
          busy = false
        }
      },
      async sleep(wait) {
        const ms = durationSeconds(wait, `workflow('${name}')'s sleep`) * 1000
        const { seen } = enter('sleep', '')

        if (seen)
          return

        busy = true
        memo.push({ kind: 'sleep', name: '', value: undefined })

        return suspend(undefined, Date.now() + ms)
      },
      async waitFor(event: string, waitOptions?: { timeout: Duration }): Promise<never> {
        const { slot, seen } = enter('wait', event)
        const reply = (kept: WaitMemo) => (waitOptions === undefined ? kept.data : waited(event, kept)) as never

        if (seen)
          return reply(seen.value as WaitMemo)

        // Taken again with no result kept: only the timeout makes a waiting run due.
        if (payload.waiting?.index === slot && payload.waiting.event === event) {
          const value: WaitMemo = { timedOut: true }

          memo.push({ kind: 'wait', name: event, value })

          return await keep() ? reply(value) : halt()
        }

        const early = inbox.findIndex(sent => sent.event === event)

        // The event came before the run waited for it.
        if (early !== -1) {
          const [sent] = inbox.splice(early, 1)
          const value: WaitMemo = { timedOut: false, data: sent!.data }

          memo.push({ kind: 'wait', name: event, value })

          return await keep() ? reply(value) : halt()
        }

        const ms = waitOptions === undefined ? undefined : durationSeconds(waitOptions.timeout, `workflow('${name}')'s waitFor timeout`) * 1000

        busy = true

        return suspend({ event, index: slot }, ms === undefined ? NEVER : Date.now() + ms)
      },
    } as WorkflowStep<Known>

    const run = (async () => {
      try {
        await flow({ id: payload.run, input: payload.input, step })
      }
      catch (error) {
        if (!halted)
          throw error
      }
    })()

    await Promise.race([run, ended.promise])
  }

  const { queued, admin } = jobQueue<Payload<Input>>(queueName, handler, {
    ...rest,
    ...own && { store: own },
    ...onStart && {
      // A run taken again after a sleep, a wait or a retry is no start.
      onStart: ({ payload, attempts, context }) => payload.started !== true && attempts === 1 ? onStart({ id: payload.run, input: payload.input, context }) : undefined,
    },
    ...onSuccess && {
      onSuccess: ({ payload, context }) => onSuccess({ id: payload.run, input: payload.input, context }),
    },
    ...onRetry && {
      onRetry: ({ payload, attempts, error, wait, context }) => onRetry({ id: payload.run, input: payload.input, attempts, error, wait, context }),
    },
    ...onError && {
      onError: ({ payload, attempts, error, context }) => onError({ id: payload.run, input: payload.input, attempts, error, context }),
    },
  }, 'workflow')

  const found = async (id: string) => {
    const state = needs(storeOf(), name).state
    const job = await state(queueName, { key: id }, Date.now())

    return job && { job, payload: parse(job.payload) as Payload<Input> }
  }

  const flowSend = async (id: string, event: string, data?: unknown, onlyWaiting = false) => {
    const store = storeOf()
    const { update } = needs(store, name)
    const run = await found(id)

    // A run a step is running, or a worker has just taken, is held: its event is dropped.
    if (run?.job.status !== 'waiting')
      return false

    // An event named by what a person read off a screen must not be kept for a later wait.
    if (onlyWaiting && run.payload.waiting?.event !== event)
      return false

    const now = Date.now()

    // A run not waiting for it yet keeps the event for the wait that names it.
    if (run.payload.waiting?.event !== event) {
      const inbox = [...run.payload.inbox ?? [], { event, data }]

      if (inbox.length > INBOX_LIMIT) {
        const [dropped] = inbox.splice(0, inbox.length - INBOX_LIMIT)

        kayLog('warn', `workflow('${name}') run '${id}' kept more than ${INBOX_LIMIT} events no wait named: the oldest, '${dropped!.event}', was dropped`)
      }

      return update(run.job.id, { payload: stringify({ ...run.payload, inbox }) }, { payload: run.job.payload, now })
    }

    const entry: Entry = { kind: 'wait', name: event, value: { timedOut: false, data } satisfies WaitMemo }
    const woken = await update(run.job.id, woke(store, run.payload, entry, now), { payload: run.job.payload, now })

    if (woken)
      admin.wake()

    return woken
  }

  const flowCancel = async (id: string) => {
    const run = await found(id)

    if (run === undefined)
      return false

    await storeOf().complete(run.job.id)

    return true
  }

  admin.workflow = { send: async (id, event, data) => flowSend(id, event, data, true), cancel: async jobId => storeOf().complete(jobId) }

  return Object.assign(queued as Elysia, {
    start: async (input?: Input, startOptions: StartOptions = {}) => {
      const id = startOptions.key ?? startOptions.id ?? crypto.randomUUID()

      if (id === '')
        throw new KayError('config-invalid', `kay: workflow('${name}') was started with an empty key; a key is a non-empty string`)

      await queued.enqueue({ run: id, input: input as Input, memo: [] } satisfies Payload<Input>, { key: id, ...startOptions.delay !== undefined && { delay: startOptions.delay } })

      return id
    },
    send: flowSend,
    status: async (id: string): Promise<WorkflowStatus | undefined> => {
      const run = await found(id)

      if (!run)
        return undefined

      const { job, payload } = run
      const base = { steps: stepsDone(payload), ...job.error !== undefined && { error: job.error } }

      if (job.status === 'waiting' && payload.waiting)
        return { status: 'waiting', event: payload.waiting.event, ...base }

      return { status: job.status === 'waiting' ? 'sleeping' : job.status, ...base }
    },
    cancel: flowCancel,
    drain: queued.drain,
  })
}
