import type { DevTool } from '../src/runtime/dev-tool'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import dataTab from '../src/runtime/dev-tab-data'
import { startDevTool } from '../src/runtime/dev-tool'
import { loadTab } from './helpers/dev-tabs'
import { eventually } from './helpers/eventually'

beforeAll(() => {
  GlobalRegistrator.register()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const TABLES = [
  { schema: 'public', name: 'users', estimate: 2, columns: [{ name: 'id', type: 'integer', kind: 'text', primary: true }, { name: 'name', type: 'text', kind: 'text', primary: false }] },
  { schema: 'audit', name: 'log', estimate: -1, columns: [{ name: 'at', type: 'timestamptz', kind: 'text', primary: false }] },
]

const POSTGRES = { id: 'postgres', label: 'Postgres', kind: 'postgres' }
const AUTH = { id: 'sqlite:data/auth.db', label: 'data/auth.db', kind: 'sqlite' }
const overview = (tables = TABLES, databases = [POSTGRES], database = databases[0]!.id) => ({ configured: true, databases, database, searched: [], tables })

describe('the Data tab', () => {
  let tool: DevTool | undefined
  const shadow = () => document.querySelector('kay-dev')!.shadowRoot!

  afterEach(() => {
    tool?.stop()
    tool = undefined
  })

  // The tab's module run on a tab of its own, as the tool runs it on first open.
  const open = (answer: (url: string, init?: RequestInit) => Response) => {
    const calls: string[] = []
    const fetching = spyOn(window, 'fetch').mockImplementation((async (url: string, init?: RequestInit) => {
      if (url.startsWith('/_kay/dev/data'))
        calls.push(`${init?.method ?? 'GET'} ${url}`)

      return answer(url, init)
    }) as unknown as typeof window.fetch)

    tool = startDevTool(document, loadTab)

    const tab = tool.tab({ id: 'data-under-test', label: 'Data' })
    const refresh = dataTab(tool, tab)

    refresh()

    return { panel: tab.panel, calls, refresh, done: () => fetching.mockRestore() }
  }

  it('says an app with no database has none, and offers no query box', async () => {
    const { panel, done } = open(() => Response.json({ configured: false, databases: [], database: undefined, searched: ['DATABASE_URL (not set)', 'data/*.db'], tables: [] }))

    await eventually(() => {
      expect(panel.querySelector('.note')!.textContent).toContain('no database')
      expect(panel.querySelector('.note')!.textContent).toContain('DATABASE_URL (not set); data/*.db')
      expect(panel.querySelector<HTMLElement>('select')!.hidden).toBe(true)
      expect(panel.querySelector<HTMLElement>('textarea')!.hidden).toBe(true)
    })
    done()
  })

  it('lists the tables, reads one page at a time and moves between pages', async () => {
    const { panel, calls, done } = open((url) => {
      if (url.startsWith('/_kay/dev/data?') || url === '/_kay/dev/data')
        return Response.json(overview())

      const page = Number(new URL(url, 'http://x').searchParams.get('page'))

      return Response.json({ columns: ['id', 'name'], rows: [[String(page * 50 + 1), page === 0 ? null : 'Grace']], page, pageSize: 50, hasMore: page === 0 })
    })

    const buttons = () => [...panel.querySelectorAll<HTMLButtonElement>('.chips button')]

    await eventually(() => expect(buttons().map(button => button.textContent)).toEqual(['users', 'audit.log']))
    buttons()[0]!.click()
    await eventually(() => {
      expect(calls.at(-1)).toBe('GET /_kay/dev/data/rows?table=public.users&page=0&db=postgres')
      expect([...panel.querySelectorAll('td')].map(td => td.textContent)).toEqual(['1', 'NULL'])
      expect(panel.querySelector('td.null')).not.toBeNull()
      expect(panel.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('select * from users limit 50')
    })

    const [previous, next] = [...panel.querySelectorAll<HTMLButtonElement>('.stack .actions button')]

    expect(previous!.disabled).toBe(true)
    next!.click()
    await eventually(() => {
      expect(calls.at(-1)).toBe('GET /_kay/dev/data/rows?table=public.users&page=1&db=postgres')
      expect([...panel.querySelectorAll('td')].map(td => td.textContent)).toEqual(['51', 'Grace'])
      expect(panel.querySelector<HTMLButtonElement>('.stack .actions button:nth-child(2)')!.disabled).toBe(true)
    })
    done()
  })

  it('posts the query with the dev tool header and shows a refusal as the answer', async () => {
    const sent: [string, string | undefined, Record<string, string>][] = []
    const { panel, done } = open((url, init) => {
      if (url !== '/_kay/dev/data/query')
        return Response.json(overview())

      sent.push([url, init?.body as string, init?.headers as Record<string, string>])

      return (JSON.parse(init!.body as string) as { sql: string }).sql.startsWith('drop') ? Response.json({ error: 'the box only reads' }, { status: 400 }) : Response.json({ columns: ['n'], rows: [['1'], ['2']], truncated: true })
    })

    const input = panel.querySelector<HTMLTextAreaElement>('textarea')!
    const run = () => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Run query')!

    await eventually(() => expect(panel.querySelector('select')!.options).toHaveLength(1))
    input.value = 'select n from t'
    run().click()
    await eventually(() => {
      expect(sent[0]![2]['x-kay-dev']).toBe('1')
      expect(JSON.parse(sent[0]![1]!)).toEqual({ sql: 'select n from t', db: 'postgres' })
      expect([...panel.querySelectorAll('td')].map(td => td.textContent)).toEqual(['1', '2'])
      expect(panel.textContent).toContain('Only the first 2 rows are shown.')
    })

    input.value = 'drop table t'
    run().click()
    await eventually(() => {
      expect(panel.querySelector('.empty')!.textContent).toBe('the box only reads')
      expect(run().disabled).toBe(false)
    })
    done()
  })

  it('switches between the databases of the app, each read through its own id', async () => {
    const { panel, calls, done } = open((url) => {
      if (url.startsWith('/_kay/dev/data/rows'))
        return Response.json({ columns: ['a'], rows: [['1']], page: 0, pageSize: 50, hasMore: false })

      const lite = url.includes('db=sqlite')

      return Response.json(overview(lite ? [{ schema: 'main', name: 'sessions', estimate: -1, columns: [{ name: 'a', type: '', kind: 'text', primary: false }] }] : TABLES, [POSTGRES, AUTH], lite ? AUTH.id : POSTGRES.id))
    })
    const select = panel.querySelector<HTMLSelectElement>('select')!

    await eventually(() => expect([...select.options].map(option => option.value)).toEqual(['postgres', 'sqlite:data/auth.db']))
    expect(select.hidden).toBe(false)
    select.value = AUTH.id
    select.dispatchEvent(new Event('change'))
    await eventually(() => {
      expect(calls.at(-1)).toBe('GET /_kay/dev/data?db=sqlite%3Adata%2Fauth.db')
      expect([...panel.querySelectorAll('.chips button')].map(button => button.textContent)).toEqual(['sessions'])
      expect(panel.textContent).toContain('opened read-only')
    })
    panel.querySelector<HTMLButtonElement>('.chips button')!.click()
    await eventually(() => {
      expect(calls.at(-1)).toBe('GET /_kay/dev/data/rows?table=main.sessions&page=0&db=sqlite%3Adata%2Fauth.db')
      expect(panel.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('select * from sessions limit 50')
    })
    done()
  })

  it('says why the tables could not be read', async () => {
    const { panel, done } = open(() => Response.json({ error: 'connection refused' }, { status: 502 }))

    await eventually(() => expect(panel.querySelector('.note')!.textContent).toBe('Could not read the database: connection refused'))
    done()
  })

  it('opens from the rail without its code in the tool, saying so when the module cannot be loaded', async () => {
    tool = startDevTool(document, loadTab)
    shadow().querySelector<HTMLButtonElement>('#kay-dev-tab-data')!.click()
    await eventually(() => expect(shadow().querySelector('#kay-dev-data .empty')?.textContent).toContain('Could not load the Data tab'))
  })
})
