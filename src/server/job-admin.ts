import type { StoredJob, StoredJobState } from './queue'
import type { RunView, WorkflowAdmin } from './workflow'
import { queueAdmins } from './queue'
import { runView, WORKFLOW_PREFIX, workflowAdminOf } from './workflow'

const LIVE_LIMIT = 100
const FAILED_LIMIT = 100
const TEXT_CHARS = 2000

export interface JobView {
  id: string
  status: StoredJobState['status']
  // Runs started so far.
  attempts: number
  // When it is due, in ms since the epoch.
  runAt: number
  error?: string
  key?: string
  // The payload as the store keeps it (devalue text), cut when long.
  payload: string
  progress?: string
  // Set for a run of a `workflow()`: where it stands and its kept steps.
  workflow?: RunView
}

export interface QueueView {
  name: string
  // Runs a job gets before it is kept as failed.
  attempts: number
  // Whether the store can put a failed job back: it has `revive`.
  canRetry: boolean
  // Whether the store lists every job; one that does not shows its failed jobs only.
  listsJobs: boolean
  jobs: JobView[]
  // Whether the queue has more jobs than are listed.
  truncated: boolean
}

export type JobAction = 'done' | 'no-queue' | 'no-job' | 'not-failed' | 'running' | 'unsupported' | 'not-workflow' | 'not-waiting'

export const JOB_MESSAGES: Record<Exclude<JobAction, 'done'>, [number, string]> = {
  'no-queue': [404, 'this server has no such queue'],
  'no-job': [404, 'the queue has no such job any more'],
  'not-failed': [409, 'only a failed job can be retried'],
  'running': [409, 'a running job cannot be removed'],
  'unsupported': [409, 'the queue\'s store cannot put a failed job back: it has no revive()'],
  'not-workflow': [409, 'only a workflow run can be sent an event or cancelled'],
  'not-waiting': [409, 'the run no longer waits for an event'],
}

const cut = (text: string) => text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}...` : text

function view(queue: string, job: StoredJob, status: StoredJobState['status']): JobView {
  const run = queue.startsWith(WORKFLOW_PREFIX) ? runView(status, job.payload, job.runAt) : undefined

  return { id: job.id, status, attempts: job.attempts, runAt: job.runAt, ...job.error !== undefined && { error: job.error }, ...job.key !== undefined && { key: job.key }, payload: cut(job.payload), ...job.progress !== undefined && { progress: cut(job.progress) }, ...run && { workflow: run } }
}

// Every queue this process made, with its waiting, running and failed jobs: the live ones and the failed ones each capped in the store's query, the live ones read one by one for whether a process holds them.
export async function jobOverview(): Promise<QueueView[]> {
  const found: QueueView[] = []

  for (const admin of queueAdmins()) {
    const store = admin.store()
    // One more than the cap tells whether the queue has more; a store ignoring the options is cut here instead.
    const failed = await store.failed(admin.name, FAILED_LIMIT + 1)
    const all = store.jobs === undefined ? undefined : await store.jobs(admin.name, { failed: false, limit: LIVE_LIMIT + 1 })
    const failedIds = new Set(failed.map(job => job.id))
    const live = (all ?? []).filter(job => !failedIds.has(job.id))
    const now = Date.now()
    const jobs: JobView[] = []

    for (const job of live.slice(0, LIVE_LIMIT))
      jobs.push(view(admin.name, job, (await store.state?.(admin.name, { id: job.id }, now))?.status ?? 'waiting'))

    for (const job of failed.slice(0, FAILED_LIMIT))
      jobs.push(view(admin.name, job, 'failed'))

    found.push({ name: admin.name, attempts: admin.attempts, canRetry: store.revive !== undefined, listsJobs: all !== undefined, jobs, truncated: live.length > LIVE_LIMIT || failed.length > FAILED_LIMIT })
  }

  return found
}

// The job of that id in that queue as its store reports it now.
async function stateOf(queue: string, id: string) {
  const admin = queueAdmins().find(({ name }) => name === queue)

  if (admin === undefined)
    return { admin, state: undefined }

  const store = admin.store()
  const state = await store.state?.(queue, { id }, Date.now())

  if (state !== undefined || store.state !== undefined)
    return { admin, state }

  // A store without `state` can only tell a failed job from the failed list.
  const failed = (await store.failed(queue)).find(job => job.id === id)

  return { admin, state: failed && { ...failed, status: 'failed' as const } }
}

// Puts a failed job back to wait, due now.
export async function retryJob(queue: string, id: string): Promise<JobAction> {
  const { admin, state } = await stateOf(queue, id)

  if (admin === undefined)
    return 'no-queue'

  if (state === undefined)
    return 'no-job'

  if (state.status !== 'failed')
    return 'not-failed'

  if (admin.store().revive === undefined)
    return 'unsupported'

  return await admin.retry(id) ? 'done' : 'no-job'
}

// Removes a waiting or failed job; a running one is left to finish.
export async function deleteJob(queue: string, id: string): Promise<JobAction> {
  const { admin, state } = await stateOf(queue, id)

  if (admin === undefined)
    return 'no-queue'

  if (state === undefined)
    return 'no-job'

  if (state.status === 'running')
    return 'running'

  return await admin.remove(id) === 0 ? 'no-job' : 'done'
}

// The run of a workflow queue a click names, and what drives it.
async function runOf(queue: string, id: string): Promise<{ fail: Exclude<JobAction, 'done'> } | { fail?: undefined, flow: WorkflowAdmin, state: StoredJobState, key: string }> {
  const { admin, state } = await stateOf(queue, id)
  const flow = workflowAdminOf(queue)

  if (admin === undefined)
    return { fail: 'no-queue' }

  if (state === undefined)
    return { fail: 'no-job' }

  return flow === undefined || state.key === undefined ? { fail: 'not-workflow' } : { flow, state, key: state.key }
}

// Sends the event the run waits for, without data.
export async function sendRunEvent(queue: string, id: string): Promise<JobAction> {
  const found = await runOf(queue, id)

  if (found.fail !== undefined)
    return found.fail

  const run = runView(found.state.status, found.state.payload, found.state.runAt)

  if (run?.state !== 'waiting' || run.event === undefined)
    return 'not-waiting'

  return await found.flow.send(found.key, run.event) ? 'done' : 'not-waiting'
}

// Ends a run: a sleeping or waiting one at once, a running one at its next step.
export async function cancelRun(queue: string, id: string): Promise<JobAction> {
  const found = await runOf(queue, id)

  if (found.fail !== undefined)
    return found.fail

  await found.flow.cancel(found.state.id)

  return 'done'
}

export const jobActions = { retry: retryJob, delete: deleteJob, send: sendRunEvent, cancel: cancelRun } as const
export type JobActionName = keyof typeof jobActions
