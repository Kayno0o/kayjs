import type { JobAction } from './job-admin'
import { isCrossSite } from './actions'
import { deleteJob, jobOverview, retryJob } from './job-admin'

const HEADER = 'x-kay-dev'

const MESSAGES: Record<Exclude<JobAction, 'done'>, [number, string]> = {
  'no-queue': [404, 'this server has no such queue'],
  'no-job': [404, 'the queue has no such job any more'],
  'not-failed': [409, 'only a failed job can be retried'],
  'running': [409, 'a running job cannot be removed'],
  'unsupported': [409, 'the queue\'s store cannot put a failed job back: it has no revive()'],
}

function guarded(request: Request): Response | undefined {
  return request.headers.get(HEADER) === null || isCrossSite(request) ? new Response(null, { status: 403 }) : undefined
}

// The queues of the running app and their jobs, for the dev tool's Jobs tab.
export async function devJobs(request: Request): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  try {
    return Response.json({ queues: await jobOverview() })
  }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}

// Retries or deletes the job a click names.
export async function devJobAction(request: Request, act: 'retry' | 'delete'): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  let body: { queue?: unknown, id?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return Response.json({ error: 'the request holds no JSON' }, { status: 400 })
  }

  if (typeof body.queue !== 'string' || typeof body.id !== 'string')
    return Response.json({ error: 'queue and id are texts' }, { status: 400 })

  try {
    const done = await (act === 'retry' ? retryJob : deleteJob)(body.queue, body.id)

    if (done === 'done')
      return Response.json({ done: true })

    const [status, error] = MESSAGES[done]

    return Response.json({ error }, { status })
  }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
