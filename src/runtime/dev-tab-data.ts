import type { DevDataOverview, DevQueryResult, DevRows, DevTable } from '../server/dev-data'
import type { DevTab, DevTool } from './dev-tool'

// The Data tab's code, fetched the first time the tab opens: the tables of the app's database, a page of rows of one, and a box for a read-only query. It imports types only, as the browser loads it as it is.
const HEADERS = { 'x-kay-dev': '1' }
const SAMPLE = 'select * from '

const label = (table: Pick<DevTable, 'schema' | 'name'>) => table.schema === 'public' ? table.name : `${table.schema}.${table.name}`

async function ask<Answer>(url: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { ...HEADERS, ...init?.headers } })
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

function grid(tool: DevTool, columns: string[], rows: (string | null)[][]): HTMLElement {
  const wrapper = tool.make('div', 'scroll')
  const table = tool.make('table', 'grid')
  const head = tool.make('tr')

  for (const column of columns)
    head.append(tool.make('th', '', column))

  table.append(head)

  for (const values of rows) {
    const row = tool.make('tr')

    for (const value of values)
      row.append(value === null ? tool.make('td', 'null', 'NULL') : tool.make('td', '', value))

    table.append(row)
  }

  wrapper.append(table)

  return wrapper
}

const failure = (error: unknown) => error instanceof Error ? error.message : String(error)

export default function dataTab(tool: DevTool, tab: DevTab): () => void {
  const status = tool.make('div', 'note')
  const picker = tool.make('div', 'chips')
  const rows = tool.make('div', 'stack')
  const input = tool.make('textarea', 'query')
  const run = tool.make('button', 'tool', 'Run query')
  const result = tool.make('div', 'stack')
  let shown: DevTable | undefined
  let page = 0

  input.setAttribute('aria-label', 'Read-only SQL query')
  input.placeholder = 'select * from users limit 10'
  input.spellcheck = false
  run.type = 'button'

  const showRows = async () => {
    if (shown === undefined)
      return

    try {
      const found = await ask<DevRows>(`/_kay/dev/data/rows?table=${encodeURIComponent(`${shown.schema}.${shown.name}`)}&page=${page}`)
      const previous = tool.make('button', 'tool', 'Previous')
      const next = tool.make('button', 'tool', 'Next')
      const actions = tool.make('div', 'actions')
      const first = found.page * found.pageSize + 1

      previous.type = next.type = 'button'
      previous.disabled = found.page === 0
      next.disabled = !found.hasMore
      previous.onclick = () => {
        page--
        void showRows()
      }
      next.onclick = () => {
        page++
        void showRows()
      }
      actions.append(previous, next, tool.make('span', 'note', found.rows.length === 0 ? 'No rows.' : `Rows ${first} to ${first + found.rows.length - 1}${found.hasMore ? '' : ', the last page'}`))
      rows.replaceChildren(tool.make('h3', 'heading', label(shown)), actions, grid(tool, found.columns, found.rows))
    }
    catch (error) {
      rows.replaceChildren(tool.make('div', 'empty', `Could not read the rows: ${failure(error)}`))
    }
  }

  const choose = (table: DevTable, button: HTMLButtonElement) => {
    shown = table
    page = 0

    for (const other of picker.querySelectorAll('button'))
      other.setAttribute('aria-pressed', String(other === button))

    if (input.value === '')
      input.value = `${SAMPLE}${label(table)} limit 50`

    void showRows()
  }

  run.onclick = async () => {
    run.disabled = true

    try {
      const found = await ask<DevQueryResult>('/_kay/dev/data/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: input.value }) })

      result.replaceChildren(found.columns.length === 0 ? tool.make('div', 'note', 'No rows.') : grid(tool, found.columns, found.rows), ...found.truncated ? [tool.make('div', 'note', `Only the first ${found.rows.length} rows are shown.`)] : [])
    }
    catch (error) {
      result.replaceChildren(tool.make('div', 'empty', failure(error)))
    }
    finally {
      run.disabled = false
    }
  }

  let asked = 0
  const list = async () => {
    const id = ++asked

    try {
      const found = await ask<DevDataOverview>('/_kay/dev/data')

      if (id !== asked)
        return

      picker.replaceChildren()
      tab.count(found.tables.length)
      input.hidden = run.hidden = !found.configured

      if (!found.configured) {
        status.textContent = 'The app has no Postgres database: set DATABASE_URL to a postgres:// address to list its tables here.'
        rows.replaceChildren()

        return
      }

      status.textContent = found.tables.length === 0 ? 'The database has no tables yet.' : 'Pick a table to read its rows, 50 at a time.'

      for (const table of found.tables) {
        const button = tool.make('button', 'tool', label(table))

        button.type = 'button'
        button.title = `${table.columns.length} columns, ${table.estimate < 0 ? 'not counted yet' : `about ${table.estimate} rows`}`
        button.setAttribute('aria-pressed', String(table.schema === shown?.schema && table.name === shown.name))
        button.onclick = () => choose(table, button)
        picker.append(button)
      }
    }
    catch (error) {
      status.textContent = `Could not read the database: ${failure(error)}`
    }
  }

  tab.panel.append(status, picker, rows, input, run, result)

  return () => void list()
}
