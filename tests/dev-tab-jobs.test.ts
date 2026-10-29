import type { DevTool } from '../src/runtime/dev-tool'
import type { QueueView } from '../src/server/job-admin'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import jobsTab from '../src/runtime/dev-tab-jobs'
import { startDevTool } from '../src/runtime/dev-tool'
import { loadTab } from './helpers/dev-tabs'
import { eventually } from './helpers/eventually'

beforeAll(() => {
  GlobalRegistrator.register()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const job = (overrides: Partial<QueueView['jobs'][number]>): QueueView['jobs'][number] => ({ id: 'j1', status: 'waiting', attempts: 0, runAt: 0, payload: '[{"n":1}]', ...overrides })
const queueOf = (overrides: Partial<QueueView> = {}): QueueView => ({ name: 'mails', attempts: 3, canRetry: true, listsJobs: true, jobs: [], truncated: false, ...overrides })

describe('the Jobs tab', () => {
  let tool: DevTool | undefined

  afterEach(() => {
    tool?.stop()
    tool = undefined
  })

  const open = (answer: (url: string, init?: RequestInit) => Response) => {
    const calls: [string, string | undefined][] = []
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      calls.push([`${init?.method ?? 'GET'} ${url}`, init?.body as string | undefined])

      return answer(url, init)
    }) as unknown as typeof window.fetch)

    tool = startDevTool(document, loadTab)

    const tab = tool.tab({ id: 'jobs-under-test', label: 'Jobs' })
    const refresh = jobsTab(tool, tab)

    refresh()

    return { panel: tab.panel, calls, refresh, done: () => fetching.mockRestore() }
  }

  it('says an app with no queue has none', async () => {
    const { panel, done } = open(() => Response.json({ queues: [] }))

    await eventually(() => expect(panel.querySelector('.note')!.textContent).toContain('no queue'))
    done()
  })

  it('lists each queue\'s jobs by status with a failed one\'s error, and offers retry only for a failed job', async () => {
    const { panel, done } = open(() => Response.json({ queues: [queueOf({ jobs: [job({ id: 'a', status: 'running', attempts: 1 }), job({ id: 'b' }), job({ id: 'c', status: 'failed', attempts: 3, error: 'Error: smtp down' })] })] }))

    await eventually(() => {
      expect([...panel.querySelectorAll('.row .pill')].map(pill => pill.textContent)).toEqual(['running', 'waiting', 'failed'])
      expect(panel.querySelector('.value')!.textContent).toBe('Error: smtp down')
      expect([...panel.querySelectorAll('.row')].map(row => [...row.querySelectorAll('button')].map(button => button.textContent).join('+'))).toEqual(['Delete', 'Delete', 'Retry+Delete'])
      expect(panel.querySelector<HTMLButtonElement>('.row button')!.disabled).toBe(true)
      expect(panel.querySelector('details pre')!.textContent).toBe('[{"n":1}]')
    })
    done()
  })

  it('posts a retry and a delete with the dev tool header, reads the queues again and says what happened', async () => {
    let failed = true
    const { panel, calls, done } = open((url) => {
      if (url === '/_kay/dev/jobs')
        return Response.json({ queues: [queueOf({ jobs: failed ? [job({ id: 'c', status: 'failed', attempts: 3, error: 'boom' })] : [job({ id: 'c' })] })] })

      return Response.json({ done: true })
    })

    const retry = () => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!

    await eventually(() => expect(retry()).toBeDefined())
    failed = false
    retry().click()
    await eventually(() => {
      expect(calls.at(-2)).toEqual(['POST /_kay/dev/jobs/retry', JSON.stringify({ queue: 'mails', id: 'c' })])
      expect(calls.at(-1)![0]).toBe('GET /_kay/dev/jobs')
      expect(panel.querySelector('.note')!.textContent).toBe('Put back in mails.')
      expect(panel.querySelector('.row .pill')!.textContent).toBe('waiting')
    })

    ;[...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete')!.click()
    await eventually(() => expect(calls.find(([call]) => call === 'POST /_kay/dev/jobs/delete')![1]).toBe(JSON.stringify({ queue: 'mails', id: 'c' })))
    done()
  })

  it('shows a workflow run by its state and steps, with send for a waiting run and cancel for any', async () => {
    const run = (state: 'waiting' | 'sleeping', extra = {}) => ({ state, done: 2, steps: ['run charge', 'sleep'], ...extra })
    const { panel, calls, done } = open(() => Response.json({ queues: [queueOf({ name: 'workflow:order', jobs: [job({ id: 'a', key: 'order-1', workflow: run('waiting', { event: 'paid' }) }), job({ id: 'b', status: 'running', workflow: { state: 'running', done: 0, steps: [] } }), job({ id: 'c', workflow: run('sleeping', { until: 3_600_000 }) })] })] }))

    await eventually(() => {
      expect([...panel.querySelectorAll('.row .pill')].map(pill => pill.textContent)).toEqual(['waiting', 'running', 'sleeping'])
      expect([...panel.querySelectorAll('.row')].map(row => [...row.querySelectorAll('button')].map(button => button.textContent).join('+'))).toEqual(['Send paid+Cancel', 'Cancel', 'Cancel'])
      expect(panel.textContent).toContain('waiting for paid, 2 steps done: run charge, sleep')
      expect(panel.textContent).toContain('sleeping until 1970-01-01T01:00:00.000Z')
      expect(panel.textContent).toContain('0 steps done')
      expect(panel.querySelectorAll<HTMLButtonElement>('.row')[1]!.querySelector('button')!.disabled).toBe(false)
    })
    ;[...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send paid')!.click()

    // The send reads the queues again, which draws the rows anew, and the next field is the one of that drawing.
    const drawn = panel.querySelector('input')

    await eventually(() => {
      expect(calls.find(([call]) => call === 'POST /_kay/dev/jobs/send')![1]).toBe(JSON.stringify({ queue: 'workflow:order', id: 'a' }))
      expect(panel.querySelector('input')).not.toBe(drawn)
      expect(panel.querySelector('input')).not.toBeNull()
    })

    const field = panel.querySelector<HTMLInputElement>('input')!

    field.value = ' {"amount": 3} '
    ;[...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Send paid')!.click()
    await eventually(() => {
      expect(calls.filter(([call]) => call === 'POST /_kay/dev/jobs/send').at(-1)![1]).toBe(JSON.stringify({ queue: 'workflow:order', id: 'a', data: '{"amount": 3}' }))
      expect(panel.querySelector('.note')!.textContent).toBe('Sent the event to workflow:order.')
    })
    ;[...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!.click()
    await eventually(() => expect(calls.find(([call]) => call === 'POST /_kay/dev/jobs/cancel')![1]).toBe(JSON.stringify({ queue: 'workflow:order', id: 'a' })))
    done()
  })

  it('says why a retry failed and leaves the job to try again', async () => {
    const { panel, done } = open((_url, init) => init?.method === 'POST' ? Response.json({ error: 'the queue has no such job any more' }, { status: 404 }) : Response.json({ queues: [queueOf({ jobs: [job({ id: 'c', status: 'failed', error: 'boom' })] })] }))

    const retry = () => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!

    await eventually(() => expect(retry()).toBeDefined())

    const button = retry()

    button.click()
    await eventually(() => {
      expect(panel.querySelector('.note')!.textContent).toBe('Could not retry the job: the queue has no such job any more')
      expect(button.disabled).toBe(false)
    })
    done()
  })

  it('disables retry for a store that cannot put a failed job back and notes a store listing no jobs', async () => {
    const { panel, done } = open(() => Response.json({ queues: [queueOf({ canRetry: false, listsJobs: false, jobs: [job({ id: 'c', status: 'failed', error: 'boom' })] })] }))

    await eventually(() => {
      expect([...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.disabled).toBe(true)
      expect(panel.textContent).toContain('lists no jobs')
    })
    done()
  })

  it('opens from the rail without its code in the tool, saying so when the module cannot be loaded', async () => {
    tool = startDevTool(document, loadTab)
    document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-jobs')!.click()
    await eventually(() => expect(document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-jobs .empty')?.textContent).toContain('Could not load the Jobs tab'))
  })
})
