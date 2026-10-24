import type { Elysia } from 'elysia'
import type { JobsConfig } from '../config'
import type { Guard } from '../runtime'
import type { ActionOptions } from './actions'
import type { LoadedGuard } from './guards'
import type { JobView, QueueView } from './job-admin'
import { KayError } from '../compiler/errors'
import { isCrossSite, passGuards } from './actions'
import { escapeHtml } from './escape-html'
import { JOB_MESSAGES, jobActions, jobOverview } from './job-admin'

export const JOBS_PATH = '/_kay/jobs'
const HTML = 'text/html; charset=utf-8'
const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' }

export interface JobsPage {
  path: string
  guards: LoadedGuard[]
}

// The guards the setting names, or the error that stops the boot: the page lists payloads and deletes jobs, so it never mounts without one.
export function jobsPageOf(setting: JobsConfig | undefined): JobsPage | undefined {
  if (setting === undefined)
    return undefined

  const given = typeof setting === 'object' && setting !== null ? setting.guard as unknown : undefined
  const list = Array.isArray(given) ? given as unknown[] : [given]

  if (list.length === 0 || !list.every(check => typeof check === 'function'))
    throw new KayError('config-invalid', 'kay: `jobs` needs a `guard`, a guard function or a list of them, such as `jobs: { guard: ctx => ctx.locals.auth.requireAdmin() }`: the page lists the payloads of the queues and deletes their jobs, so it never mounts open')

  const path = setting.path ?? JOBS_PATH

  if (!path.startsWith('/') || (path.length > 1 && path.endsWith('/')))
    throw new KayError('config-invalid', `kay: \`jobs.path\` is an absolute path without a trailing slash, not ${JSON.stringify(path)}`)

  return { path, guards: list.map(check => ({ file: 'kay.config.ts', special: {}, check: check as Guard })) }
}

// A due time past the range of a Date (a store may hold any number) is shown as it is.
const time = (at: number) => Number.isNaN(new Date(at).getTime()) ? String(at) : new Date(at).toISOString()

function jobMarkup(queue: QueueView, job: JobView, action: (name: string) => string): string {
  const form = (name: 'retry' | 'delete' | 'send' | 'cancel', label: string) => `<form method="post" action="${escapeHtml(action(name))}"><input type="hidden" name="queue" value="${escapeHtml(queue.name)}"><input type="hidden" name="id" value="${escapeHtml(job.id)}"><button>${label}</button></form>`
  const retry = job.status === 'failed' && queue.canRetry ? form('retry', 'Retry') : ''
  const run = job.workflow
  const send = run?.state === 'waiting' ? form('send', `Send ${escapeHtml(run.event ?? '')}`) : ''
  const remove = run || job.status !== 'running' ? form(run ? 'cancel' : 'delete', run ? 'Cancel' : 'Delete') : ''
  const where = run === undefined ? '' : `<p>workflow run ${run.state}${run.event === undefined ? '' : ` for event <code>${escapeHtml(run.event)}</code>`}${run.until === undefined ? '' : ` until ${time(run.until)}`}, ${run.steps.length} steps done${run.steps.length === 0 ? '' : `: ${run.steps.map(step => `<code>${escapeHtml(step)}</code>`).join(' ')}`}</p>`

  return `<li><p><strong>${run?.state ?? job.status}</strong> <code>${escapeHtml(job.id)}</code> ${job.attempts} of ${queue.attempts} attempts${run === undefined ? `, due ${time(job.runAt)}` : ''}${job.key === undefined ? '' : ` key <code>${escapeHtml(job.key)}</code>`}${job.progress === undefined ? '' : ` progress ${escapeHtml(job.progress)}`}</p>${where}${job.error === undefined ? '' : `<pre>${escapeHtml(job.error)}</pre>`}<details><summary>Payload</summary><pre>${escapeHtml(job.payload)}</pre></details><div>${send}${retry}${remove}</div></li>`
}

function pageMarkup(queues: QueueView[], action: (name: string) => string): string {
  const body = queues.length === 0
    ? '<p>This server has no queue: make one with queue() from kay/server and its jobs are listed here.</p>'
    : queues.map(queue => `<section><h2>${escapeHtml(queue.name)}</h2>${queue.listsJobs ? '' : '<p>The queue\'s store lists no jobs, so only the failed ones show.</p>'}${queue.jobs.length === 0 ? '<p>No jobs.</p>' : `<ul>${queue.jobs.map(job => jobMarkup(queue, job, name => action(name))).join('')}</ul>`}${queue.truncated ? '<p>More jobs than are listed.</p>' : ''}</section>`).join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Jobs</title></head><body><h1>Jobs</h1>${body}</body></html>`
}

// Serves the page and its two actions as plain HTML forms, so it needs no script and no style under any CSP; the guards run on every request, after the cross-site check on a post.
export function serveJobsPage(app: Elysia, page: JobsPage, options: ActionOptions): void {
  const base = options.base ?? ''
  const action = (name: string) => `${base}${page.path}/${name}`

  const admit = async (context: { request: Request }): Promise<Response | undefined> => {
    const passed = await passGuards(page.guards, context, {}, options)

    return passed instanceof Response ? passed : undefined
  }

  app.get(page.path, async (context) => {
    const denied = await admit(context)

    if (denied)
      return denied

    return new Response(pageMarkup(await jobOverview(), action), { headers: { 'content-type': HTML, ...HEADERS } })
  })

  for (const act of ['retry', 'delete', 'send', 'cancel'] as const) {
    app.post(`${page.path}/${act}`, async (context) => {
      const { request } = context

      if (isCrossSite(request))
        return new Response('Forbidden', { status: 403, headers: HEADERS })

      const denied = await admit(context)

      if (denied)
        return denied

      // Elysia has read the form into `body` by now.
      const form = (typeof context.body === 'object' && context.body !== null ? context.body : {}) as Record<string, unknown>
      const queue = form.queue
      const id = form.id

      if (typeof queue !== 'string' || typeof id !== 'string')
        return new Response('Bad Request', { status: 400, headers: HEADERS })

      const done = await jobActions[act](queue, id)

      if (done !== 'done') {
        const [status, message] = JOB_MESSAGES[done]

        return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...HEADERS } })
      }

      // The base is added to a redirect by the server itself.
      return new Response(null, { status: 303, headers: { location: page.path, ...HEADERS } })
    })
  }
}
