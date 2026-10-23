import type { QueueView } from '../server/job-admin'
import type { DevTab, DevTool } from './dev-tool'

// The Jobs tab's code, fetched the first time the tab opens: each queue of the app with its running, waiting and failed jobs, a failed one's payload and error, and a button to retry or delete it. It imports types only, as the browser loads it as it is.
const HEADERS = { 'x-kay-dev': '1', 'content-type': 'application/json' }

const failure = (error: unknown) => error instanceof Error ? error.message : String(error)

async function ask<Answer>(url: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(url, { cache: 'no-store', headers: HEADERS, ...init })
  let answer = {} as Answer & { error?: string }

  try {
    answer = await response.json() as typeof answer
  }
  catch {
    // An empty or non-JSON body: the status below says what happened.
  }

  if (!response.ok)
    throw new Error(answer.error ?? `the server answered ${response.status}`)

  return answer
}

const TONES = { failed: 'error', running: 'accent', waiting: 'ok' } as const

export default function jobsTab(tool: DevTool, tab: DevTab): () => void {
  const status = tool.make('div', 'note')
  const queues = tool.make('div', 'stack')
  let asked = 0
  let reread: (() => Promise<void>) | undefined

  const act = async (action: 'retry' | 'delete', queue: string, id: string, button: HTMLButtonElement) => {
    button.disabled = true

    try {
      await ask(`/_kay/dev/jobs/${action}`, { method: 'POST', body: JSON.stringify({ queue, id }) })
      status.textContent = `${action === 'retry' ? 'Put back in' : 'Removed from'} ${queue}.`
    }
    catch (error) {
      status.textContent = `Could not ${action} the job: ${failure(error)}`
      button.disabled = false

      return
    }

    await reread?.()
  }

  const jobRow = (queue: QueueView, job: QueueView['jobs'][number]) => {
    const row = tool.make('div', 'row')
    const line = tool.make('div', 'actions')
    const retry = tool.make('button', 'tool', 'Retry')
    const remove = tool.make('button', 'tool', 'Delete')
    const details = tool.make('details', 'json')
    const body = tool.make('pre', '', job.payload)

    retry.type = remove.type = 'button'
    retry.title = queue.canRetry ? 'Run the job again from its first attempt' : 'The queue\'s store cannot put a failed job back'
    retry.disabled = !queue.canRetry
    retry.onclick = async () => act('retry', queue.name, job.id, retry)
    remove.disabled = job.status === 'running'
    remove.onclick = async () => act('delete', queue.name, job.id, remove)
    line.append(tool.make('span', `pill ${TONES[job.status]}`, job.status), tool.make('span', 'mono', job.id), tool.make('span', 'note', `${job.attempts} of ${queue.attempts} attempts`))

    if (job.key !== undefined)
      line.append(tool.make('span', 'chip', `key ${job.key}`))

    if (job.status === 'failed')
      line.append(retry)

    line.append(remove)

    const summary = tool.make('summary', '', 'Payload')

    details.append(summary, body)
    row.append(line)

    if (job.error !== undefined)
      row.append(tool.make('pre', 'value error', job.error))

    if (job.progress !== undefined)
      row.append(tool.make('div', 'note', `progress ${job.progress}`))

    row.append(details)

    return row
  }

  // Reads the queues again; the notice about the last click stays on screen when `keepNotice`.
  const list = async (keepNotice = false) => {
    const id = ++asked

    try {
      const { queues: found } = await ask<{ queues: QueueView[] }>('/_kay/dev/jobs', { method: 'GET' })

      if (id !== asked)
        return

      const failed = found.reduce((sum, queue) => sum + queue.jobs.filter(job => job.status === 'failed').length, 0)

      tab.count(failed, failed > 0 ? 'error' : undefined)

      if (found.length === 0) {
        status.textContent = 'The app has no queue: make one with queue() from kay/server and this tab lists its jobs.'
        queues.replaceChildren()

        return
      }

      if (!keepNotice)
        status.textContent = ''

      queues.replaceChildren(...found.map((queue) => {
        const group = tool.make('div', 'group')
        const heading = tool.make('h3', 'heading', queue.name)

        group.append(heading)

        if (!queue.listsJobs)
          group.append(tool.make('div', 'note', 'The queue\'s store lists no jobs, so only the failed ones show.'))

        if (queue.jobs.length === 0)
          group.append(tool.make('div', 'empty', 'No jobs.'))
        else
          group.append(...queue.jobs.map(job => jobRow(queue, job)))

        if (queue.truncated)
          group.append(tool.make('div', 'note', 'More jobs than are listed.'))

        return group
      }))
    }
    catch (error) {
      if (id === asked)
        status.textContent = `Could not list the jobs: ${failure(error)}`
    }
  }

  reread = async () => list(true)
  tab.panel.append(status, queues)

  return () => void list()
}
