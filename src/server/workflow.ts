import type { Elysia } from 'elysia'
import type { Duration } from '../runtime/duration'
import type { JobContext, JobStore, QueueOptions } from './queue'
import { parse, stringify } from 'devalue'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { kayLog } from '../runtime/log'
import { claimHolds, defaultJobStore, GiveUpError, handedBack, queue, wakeQueue } from './queue'
import { onReload } from './reload'

type Events = Record<string, unknown>

// What a wait with a timeout resolves with: the event's data, or that the timeout came first.
export type WaitResult<Data> = { timedOut: false, data: Data } | { timedOut: true, data?: undefined }

export interface WorkflowStep<Known extends Events> {
  // Runs `work` once for the run and keeps its result, a value devalue keeps, in the store: a restart or a retry gets the kept result back instead of running it again. Steps run one at a time, each awaited before the next.
  run: <Result>(name: string, work: (signal: AbortSignal) => Result | Promise<Result>) => Promise<Awaited<Result>>
  // Lets the run go for `wait`: nothing holds a process meanwhile, and the code after it runs once the time comes, in whichever process takes the run.
  sleep: (wait: Duration) => Promise<void>
  // Waits for `send(id, event, data)` to this run and resolves with its data; with a `timeout`, resolves with `{ timedOut: true }` when the time comes first.
  waitFor: {
    <Event extends keyof Known & string>(event: Event): Promise<Known[Event]>
    <Event extends keyof Known & string>(event: Event, options: { timeout: Duration }): Promise<WaitResult<Known[Event]>>
  }
}

export interface WorkflowRun<Input, Known extends Events> {
  // The run's id: the `id` it started with, else one made for it.
  id: string
  input: Input
  step: WorkflowStep<Known>
}

export interface WorkflowOptions<Input> extends Pick<QueueOptions<never>, 'store' | 'attempts' | 'backoff' | 'concurrency' | 'lostAfter' | 'idlePoll' | 'keepFailed'> {
  // Gets a run that failed its last attempt, once it is kept as failed.
  onFailed?: ((event: { id: string, input: Input, error: unknown }) => unknown) | undefined
}

export interface StartOptions {
  // Names the run: while a run with this id is live (waiting, sleeping or running), starting it again starts nothing and resolves with the same id. `send`, `status` and `cancel` take it, so a user's id here is all an app keeps. A random id otherwise.
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
  memo: Entry[]
  // Events sent before the run waited for them, taken in order by the waits that name them.
  inbox?: { event: string, data: unknown }[] | undefined
  // Set while the run waits for an event, until its timeout.
  waiting?: { event: string, index: number } | undefined
}

const noop = () => undefined
const RELEASE_TRIES = 3

// Events kept for a wait that does not name them yet, per run: past it the oldest is dropped.
export const INBOX_LIMIT = 50

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

  if (!Array.isArray(payload?.memo) || !payload.memo.every(entry => typeof entry?.kind === 'string' && typeof entry.name === 'string') || (payload.waiting !== undefined && typeof payload.waiting.event !== 'string'))
    return undefined

  const label = (entry: Entry) => entry.kind === 'sleep' ? 'sleep' : `${entry.kind} ${entry.name}`.slice(0, NAME_CHARS)
  const steps = payload.memo.slice(-STEP_NAMES).map(label)
  const done = payload.memo.length
  const until = runAt < NEVER ? { until: runAt } : {}

  if (status === 'waiting' && payload.waiting)
    return { state: 'waiting', event: payload.waiting.event, ...until, done, steps }

  return { state: status === 'waiting' ? 'sleeping' : status, ...status === 'waiting' && until, done, steps }
}

// What the dev tool and the jobs page act on a run with, by the name of its queue.
export interface WorkflowAdmin {
  send: (id: string, event: string) => Promise<boolean>
  // Ends the run held by that job of the queue.
  cancel: (jobId: string) => Promise<void>
}

const workflowAdmins = new Map<string, WorkflowAdmin>()

export function workflowAdminOf(queueName: string): WorkflowAdmin | undefined {
  return workflowAdmins.get(queueName)
}

function needs(store: JobStore, name: string): { [Method in 'update' | 'release' | 'state']-?: NonNullable<JobStore[Method]> } {
  const { update, release, state } = store

  if (!update || !release || !state)
    throw new KayError('config-invalid', `kay: workflow('${name}')'s store has no update(), release() and state(): add them to the JobStore, or use sqliteJobs, memoryJobs or pgJobs`)

  return { update: update.bind(store), release: release.bind(store), state: state.bind(store) }
}

// A flow of steps that survives restarts, sleeps without holding a process and waits for events: `start` it from an action, `app.use(flow)` in the server to run it, `send` it an event.
// The function runs again from its top each time the run is taken, and each finished step gives its kept result back, so what lies between steps must give the same answer every time. The run is one job of the queue `workflow:<name>` kept under its id, and its results are kept in that job after each step.
export function workflow<Input = undefined, Known extends Events = Events>(name: string, flow: (run: WorkflowRun<Input, Known>) => unknown, options: WorkflowOptions<Input> = {}): Workflow<Input, Known> {
  const queueName = `${WORKFLOW_PREFIX}${name}`
  const { onFailed, store: own, ...rest } = options
  const storeOf = () => own ?? defaultJobStore()

  const handler = async (payload: Payload<Input>, signal: AbortSignal, job: JobContext<unknown>) => {
    const { update, release } = needs(storeOf(), name)
    const until = claimHolds.get(job)!
    const memo = [...payload.memo]
    const inbox = [...payload.inbox ?? []]
    let at = 0
    let busy = false
    let halted = false
    const ended = Promise.withResolvers<void>()

    // Ends the claim without the code after the step running: the step's promise never settles, so a `try` around it catches nothing.
    const halt = async (): Promise<never> => {
      halted = true
      handedBack.add(job)
      ended.resolve()

      return new Promise<never>(noop)
    }

    // A kept step starts the attempts again, as the store does for the stored count.
    const keep = async (waiting?: Payload<Input>['waiting'], runAt?: number) => {
      const kept = await update(job.id, { payload: stringify({ ...payload, memo, inbox, waiting }), runAt }, { until })

      if (kept)
        job.attempts = 1

      return kept
    }

    // A write refused means the run was cancelled or went to another process: nothing more of it is ours to do.
    const suspend = async (waiting?: Payload<Input>['waiting'], runAt?: number): Promise<never> => {
      if (await keep(waiting, runAt)) {
        // A store that fails here would have the queue retry the run, moving its due time: ask again first.
        for (let tries = 1; ; tries++) {
          try {
            await release(job.id, until)

            break
          }
          catch (error) {
            if (tries === RELEASE_TRIES)
              throw error

            await Bun.sleep(100 * tries)
          }
        }
      }

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
        const { seen } = enter('run', label)

        if (seen)
          return seen.value as never

        busy = true

        try {
          const value = await work(signal)

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
        const reply = (result: WaitResult<unknown>) => (waitOptions === undefined ? result.data : result) as never

        if (seen)
          return reply(seen.value as WaitResult<unknown>)

        // Taken again with no result kept: only the timeout makes a waiting run due.
        if (payload.waiting?.index === slot && payload.waiting.event === event) {
          const value: WaitResult<unknown> = { timedOut: true }

          memo.push({ kind: 'wait', name: event, value })

          return await keep() ? reply(value) : halt()
        }

        const early = inbox.findIndex(sent => sent.event === event)

        // The event came before the run waited for it.
        if (early !== -1) {
          const [sent] = inbox.splice(early, 1)
          const value: WaitResult<unknown> = { timedOut: false, data: sent!.data }

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

  const queued = queue<Payload<Input>>(queueName, handler, {
    ...rest,
    ...own && { store: own },
    ...onFailed && {
      onFailed: ({ payload, error }) => onFailed({ id: payload.run, input: payload.input, error }),
    },
  })

  const found = async (id: string) => {
    const state = needs(storeOf(), name).state
    const job = await state(queueName, { key: id }, Date.now())

    return job && { job, payload: parse(job.payload) as Payload<Input> }
  }

  const flowSend = async (id: string, event: string, data?: unknown) => {
    const store = storeOf()
    const { update } = needs(store, name)
    const run = await found(id)

    // A run a step is running, or a worker has just taken, is held: its event is dropped.
    if (run?.job.status !== 'waiting')
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

    const memo: Entry[] = [...run.payload.memo, { kind: 'wait', name: event, value: { timedOut: false, data } satisfies WaitResult<unknown> }]
    const woken = await update(run.job.id, { payload: stringify({ ...run.payload, memo, waiting: undefined }), runAt: now }, { payload: run.job.payload, now })

    if (woken)
      wakeQueue(queueName)

    return woken
  }

  const flowCancel = async (id: string) => {
    const run = await found(id)

    if (run === undefined)
      return false

    await storeOf().complete(run.job.id)

    return true
  }

  workflowAdmins.set(queueName, { send: flowSend, cancel: async jobId => storeOf().complete(jobId) })
  onReload(() => {
    workflowAdmins.delete(queueName)
  })

  return Object.assign(queued as Elysia, {
    start: async (input?: Input, startOptions: StartOptions = {}) => {
      const id = startOptions.id ?? crypto.randomUUID()

      if (id === '')
        throw new KayError('config-invalid', `kay: workflow('${name}') was started with an empty id; an id is a non-empty string`)

      await queued.enqueue({ run: id, input: input as Input, memo: [] }, { key: id, ...startOptions.delay !== undefined && { delay: startOptions.delay } })

      return id
    },
    send: flowSend,
    status: async (id: string): Promise<WorkflowStatus | undefined> => {
      const run = await found(id)

      if (!run)
        return undefined

      const { job, payload } = run
      const base = { steps: payload.memo.length, ...job.error !== undefined && { error: job.error } }

      if (job.status === 'waiting' && payload.waiting)
        return { status: 'waiting', event: payload.waiting.event, ...base }

      return { status: job.status === 'waiting' ? 'sleeping' : job.status, ...base }
    },
    cancel: flowCancel,
    drain: queued.drain,
  })
}
