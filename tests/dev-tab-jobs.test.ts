import type { DevTool } from '../src/runtime/dev-tool'
import type { QueueView } from '../src/server/job-admin'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import jobsTab from '../src/runtime/dev-tab-jobs'
import { startDevTool } from '../src/runtime/dev-tool'

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

    tool = startDevTool()

    const tab = tool.tab({ id: 'jobs-under-test', label: 'Jobs' })
    const refresh = jobsTab(tool, tab)

    refresh()

    return { panel: tab.panel, calls, refresh, done: () => fetching.mockRestore() }
  }

  it('says an app with no queue has none', async () => {
    const { panel, done } = open(() => Response.json({ queues: [] }))

    await Bun.sleep(0)
    expect(panel.querySelector('.note')!.textContent).toContain('no queue')
    done()
  })

  it('lists each queue\'s jobs by status with a failed one\'s error, and offers retry only for a failed job', async () => {
    const { panel, done } = open(() => Response.json({ queues: [queueOf({ jobs: [job({ id: 'a', status: 'running', attempts: 1 }), job({ id: 'b' }), job({ id: 'c', status: 'failed', attempts: 3, error: 'Error: smtp down' })] })] }))

    await Bun.sleep(0)
    expect([...panel.querySelectorAll('.row .pill')].map(pill => pill.textContent)).toEqual(['running', 'waiting', 'failed'])
    expect(panel.querySelector('.value')!.textContent).toBe('Error: smtp down')
    expect([...panel.querySelectorAll('.row')].map(row => [...row.querySelectorAll('button')].map(button => button.textContent).join('+'))).toEqual(['Delete', 'Delete', 'Retry+Delete'])
    expect(panel.querySelector<HTMLButtonElement>('.row button')!.disabled).toBe(true)
    expect(panel.querySelector('details pre')!.textContent).toBe('[{"n":1}]')
    done()
  })

  it('posts a retry and a delete with the dev tool header, reads the queues again and says what happened', async () => {
    let failed = true
    const { panel, calls, done } = open((url) => {
      if (url === '/_kay/dev/jobs')
        return Response.json({ queues: [queueOf({ jobs: failed ? [job({ id: 'c', status: 'failed', attempts: 3, error: 'boom' })] : [job({ id: 'c' })] })] })

      return Response.json({ done: true })
    })

    await Bun.sleep(0)

    const retry = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!

    failed = false
    retry.click()
    await Bun.sleep(0)
    expect(calls.at(-2)).toEqual(['POST /_kay/dev/jobs/retry', JSON.stringify({ queue: 'mails', id: 'c' })])
    expect(calls.at(-1)![0]).toBe('GET /_kay/dev/jobs')
    expect(panel.querySelector('.note')!.textContent).toBe('Put back in mails.')
    expect(panel.querySelector('.row .pill')!.textContent).toBe('waiting')

    ;[...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Delete')!.click()
    await Bun.sleep(0)
    expect(calls.find(([call]) => call === 'POST /_kay/dev/jobs/delete')![1]).toBe(JSON.stringify({ queue: 'mails', id: 'c' }))
    done()
  })

  it('says why a retry failed and leaves the job to try again', async () => {
    const { panel, done } = open((_url, init) => init?.method === 'POST' ? Response.json({ error: 'the queue has no such job any more' }, { status: 404 }) : Response.json({ queues: [queueOf({ jobs: [job({ id: 'c', status: 'failed', error: 'boom' })] })] }))

    await Bun.sleep(0)

    const retry = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!

    retry.click()
    await Bun.sleep(0)
    expect(panel.querySelector('.note')!.textContent).toBe('Could not retry the job: the queue has no such job any more')
    expect(retry.disabled).toBe(false)
    done()
  })

  it('disables retry for a store that cannot put a failed job back and notes a store listing no jobs', async () => {
    const { panel, done } = open(() => Response.json({ queues: [queueOf({ canRetry: false, listsJobs: false, jobs: [job({ id: 'c', status: 'failed', error: 'boom' })] })] }))

    await Bun.sleep(0)
    expect([...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry')!.disabled).toBe(true)
    expect(panel.textContent).toContain('lists no jobs')
    done()
  })

  it('opens from the rail without its code in the tool, saying so when the module cannot be loaded', async () => {
    tool = startDevTool()
    document.querySelector('kay-dev')!.shadowRoot!.querySelector<HTMLButtonElement>('#kay-dev-tab-jobs')!.click()
    await Bun.sleep(5)

    expect(document.querySelector('kay-dev')!.shadowRoot!.querySelector('#kay-dev-jobs .empty')?.textContent).toContain('Could not load the Jobs tab')
  })
})
