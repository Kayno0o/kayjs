import type { JobActionName } from './job-admin'
import { isCrossSite } from './actions'
import { JOB_MESSAGES, jobActions, jobOverview } from './job-admin'

const HEADER = 'x-kay-dev'

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

// Retries, deletes, sends an event to or cancels the job a click names.
export async function devJobAction(request: Request, act: JobActionName): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  let body: { queue?: unknown, id?: unknown, data?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return Response.json({ error: 'the request holds no JSON' }, { status: 400 })
  }

  if (typeof body.queue !== 'string' || typeof body.id !== 'string')
    return Response.json({ error: 'queue and id are texts' }, { status: 400 })

  try {
    const done = await jobActions[act](body.queue, body.id, typeof body.data === 'string' ? body.data : undefined)

    if (done === 'done')
      return Response.json({ done: true })

    const [status, error] = JOB_MESSAGES[done]

    return Response.json({ error }, { status })
  }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
