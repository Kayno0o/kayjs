import type { DevColumn, DevQueryResult, DevRows, DevTable } from './dev-data'
import { Database } from 'bun:sqlite'

export type SqliteTask = { kind: 'tables' } | { kind: 'rows', table: string, page: number } | { kind: 'query', sql: string }
export type SqliteAnswer = { tables: DevTable[] } | { rows: DevRows } | { query: DevQueryResult } | { error: string, status?: number }

const PAGE_ROWS = 50
const QUERY_ROWS = 500
const CELL_CHARS = 200
const BINARY_BYTES = 24
const QUOTE = /"/g
const SCHEMA = 'main'

interface TableRow { name: string }
interface ColumnRow { name: string, type: string, pk: number }

declare const self: { onmessage: ((event: MessageEvent<{ path: string, task: SqliteTask }>) => void) | null, postMessage: (answer: SqliteAnswer) => void }

const identifier = (name: string) => `"${name.replace(QUOTE, '""')}"`

// What a column sends: its text cut in the database, a blob as a hex prefix and its size, so a large value is never read whole.
function cell(expression: string, alias: string): string {
  const text = `CAST(${expression} AS TEXT)`

  return `CASE typeof(${expression}) WHEN 'null' THEN NULL WHEN 'blob' THEN '\\x' || lower(hex(substr(${expression}, 1, ${BINARY_BYTES}))) || CASE WHEN length(${expression}) > ${BINARY_BYTES} THEN '... (' ELSE ' (' END || length(${expression}) || ' bytes)' ELSE CASE WHEN length(${text}) > ${CELL_CHARS} THEN substr(${text}, 1, ${CELL_CHARS}) || '...' ELSE ${text} END END AS ${alias}`
}

function tables(db: Database): DevTable[] {
  const found = db.query<TableRow, []>('SELECT name FROM sqlite_master WHERE type IN (\'table\', \'view\') AND name NOT LIKE \'sqlite\\_%\' ESCAPE \'\\\' ORDER BY name').all()

  return found.map(({ name }) => ({
    schema: SCHEMA,
    name,
    estimate: -1,
    columns: db.query<ColumnRow, []>(`PRAGMA table_xinfo(${identifier(name)})`).all().map(({ name: column, type, pk }): DevColumn => ({ name: column, type, kind: type.toUpperCase().includes('BLOB') ? 'binary' : 'text', primary: pk > 0 })),
  }))
}

function rows(db: Database, wanted: string, page: number): SqliteAnswer {
  const table = tables(db).find(({ name }) => `${SCHEMA}.${name}` === wanted)

  if (table === undefined)
    return { error: `${wanted} is not a table of the database`, status: 404 }

  const keys = table.columns.filter(column => column.primary).map(column => `source.${identifier(column.name)}`)
  const columns = table.columns.map(({ name }) => name)
  const select = columns.map((name, at) => cell(`source.${identifier(name)}`, `c${at}`)).join(', ')
  const read = (order: string) => db.query<(string | null)[], []>(`SELECT ${select} FROM ${identifier(table.name)} AS source${order} LIMIT ${PAGE_ROWS + 1} OFFSET ${page * PAGE_ROWS}`).values() as (string | null)[][]
  let found: (string | null)[][]

  try {
    found = read(` ORDER BY ${keys.length === 0 ? 'source.rowid' : keys.join(', ')}`)
  }
  catch {
    // A view or a WITHOUT ROWID table with no key has no rowid: it is read in the order it answers.
    found = read('')
  }

  return { rows: { columns, rows: found.slice(0, PAGE_ROWS), page, pageSize: PAGE_ROWS, hasMore: found.length > PAGE_ROWS } }
}

function query(db: Database, text: string): SqliteAnswer {
  // The statement alone first, for its columns and for SQLite to refuse it as it is.
  const columns = db.query(text).columnNames

  if (columns.length === 0)
    return { error: 'the statement returns no rows: the box only reads' }

  // The wrapped one is read for the names SQLite gives a subquery's columns, which it makes unique where the statement repeats one.
  const unique = db.query(`SELECT * FROM (${text}\n) LIMIT 0`).columnNames
  const found = db.query<(string | null)[], []>(`SELECT ${unique.map((name, at) => cell(`source.${identifier(name)}`, `c${at}`)).join(', ')} FROM (${text}\n) AS source LIMIT ${QUERY_ROWS + 1}`).values() as (string | null)[][]

  return { query: { columns, rows: found.slice(0, QUERY_ROWS), truncated: found.length > QUERY_ROWS } }
}

// One read of a SQLite file, in a worker of its own so the dev server can stop a query that outruns its timeout, which a synchronous call cannot be interrupted from.
self.onmessage = ({ data: { path, task } }) => {
  let db: Database | undefined

  try {
    db = new Database(path, { readonly: true })
    db.run('PRAGMA busy_timeout = 1000')
    db.run('PRAGMA query_only = ON')

    if (task.kind === 'tables')
      self.postMessage({ tables: tables(db) })
    else
      self.postMessage(task.kind === 'rows' ? rows(db, task.table, task.page) : query(db, task.sql))
  }
  catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
  finally {
    db?.close()
  }
}
