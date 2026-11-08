import type { SqliteAnswer, SqliteTask } from './dev-sqlite-worker'
import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { openedSqlite } from '../runtime/sqlite.server'
import { isCrossSite } from './cross-site'

const HEADER = 'x-kay-dev'
const PAGE_ROWS = 50
const MAX_PAGE = 1_000_000
const QUERY_ROWS = 500
const QUERY_TIMEOUT_MS = 5000
const CELL_CHARS = 200
const BINARY_BYTES = 24
const POSTGRES_URL = /^postgres(?:ql)?:\/\//
const QUERY_START = /^[\s(]*(?:select|with|values|table)\b/i
const FIRST_WORD = /^[\s(]*(\w*)/
// Functions a read-only transaction does not stop. A text denylist, not a sandbox: see `refusedQuery`.
const DENIED_FUNCTION = /\b(set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_notify|pg_advisory_lock\w*|pg_try_advisory_lock\w*|pg_stat_reset\w*|pg_switch_wal|pg_create_restore_point|pg_rotate_logfile|pg_logical_emit_message|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|query_to_xml\w*|cursor_to_xml|table_to_xml\w*|ts_stat|dblink\w*)\b/i
const UNICODE_ESCAPE = /u&$/i
const BYTEA_OID = 17
const IDENTIFIER_CHAR = /\w/
const ESCAPE_PREFIX = /E/i
const DOLLAR_TAG = /^\$(?:[A-Z_]\w*)?\$/i
const TRAILING_SEMICOLON = /;\s*$/
const QUOTE = /"/g
const SQLITE_URL = /^(?:sqlite:\/\/|file:)(.+)$/
const SQLITE_FILE = /\.(?:db|sqlite3?)$/i
const SQLITE_HEADER = 'SQLite format 3\0'
const DATA_FOLDER = 'data'
const MAX_WORKERS = 2
const POSTGRES_ID = 'postgres'
const SQLITE_PREFIX = 'sqlite:'

export interface DevColumn {
  name: string
  type: string
  // The type the column is shown by: bytea is cut to a hex prefix, json and jsonb are text.
  kind: 'binary' | 'json' | 'text'
  primary: boolean
}

export interface DevTable {
  schema: string
  name: string
  // Postgres' own estimate, -1 before the table was first analyzed.
  estimate: number
  columns: DevColumn[]
}

export interface DevDatabase {
  // `postgres`, or `sqlite:` and the file's path from the app's folder.
  id: string
  label: string
  kind: 'postgres' | 'sqlite'
}

export interface DevDataOverview {
  configured: boolean
  databases: DevDatabase[]
  // The id of the one whose tables are listed.
  database: string | undefined
  // Where the tool looked, said when it found no database.
  searched: string[]
  tables: DevTable[]
}

export interface DevRows {
  columns: string[]
  rows: (string | null)[][]
  page: number
  pageSize: number
  hasMore: boolean
}

export interface DevQueryResult {
  columns: string[]
  rows: (string | null)[][]
  // Whether the query had more rows than the box shows.
  truncated: boolean
}

let client: { url: string, sql: SQL } | undefined

// One connection of the dev tool's own, opened on the first request, closed when the database URL changes and by its idle timeout.
function connection(url: string): SQL {
  if (client !== undefined && client.url !== url)
    void closeDevData()

  if (client === undefined) {
    client = { url, sql: new SQL(url, { max: 1, idleTimeout: 30, connectionTimeout: 5 }) }
  }

  return client.sql
}

export async function closeDevData(): Promise<void> {
  const held = client

  client = undefined
  await held?.sql.close({ timeout: 1 })
}

// The database the dev tool shows: the app's `DATABASE_URL` when it names a Postgres.
export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL

  return url !== undefined && POSTGRES_URL.test(url) ? url : undefined
}

function isSqliteFile(path: string): boolean {
  let fd: number | undefined

  try {
    fd = openSync(path, 'r')
    const head = Buffer.alloc(SQLITE_HEADER.length)

    return readSync(fd, head, 0, head.length, 0) === head.length && head.toString('latin1') === SQLITE_HEADER
  }
  catch {
    return false
  }
  finally {
    if (fd !== undefined)
      closeSync(fd)
  }
}

function dataFiles(root: string): string[] {
  try {
    return readdirSync(join(root, DATA_FOLDER)).filter(name => SQLITE_FILE.test(name)).map(name => join(root, DATA_FOLDER, name))
  }
  catch {
    return []
  }
}

// What the Data tab can open: the app's Postgres, then every SQLite file the app named in `DATABASE_URL`, opened through `openSqlite` since it started, or kept in its `data` folder. A request only ever names one of these, never a path.
export function databases(root: string): DevDatabase[] {
  const found: DevDatabase[] = []
  const files = new Set<string>()

  if (databaseUrl() !== undefined)
    found.push({ id: POSTGRES_ID, label: 'Postgres', kind: 'postgres' })

  const named = SQLITE_URL.exec(process.env.DATABASE_URL ?? '')?.[1]

  for (const path of [...named === undefined ? [] : [resolve(root, named)], ...openedSqlite(), ...dataFiles(root)]) {
    const absolute = resolve(root, path)

    if (!files.has(absolute) && isSqliteFile(absolute)) {
      files.add(absolute)
      const shown = relative(root, absolute)
      const label = shown.startsWith('..') || isAbsolute(shown) ? absolute : shown

      found.push({ id: `${SQLITE_PREFIX}${label}`, label, kind: 'sqlite' })
    }
  }

  return found
}

function searched(root: string): string[] {
  return [`DATABASE_URL (${process.env.DATABASE_URL === undefined ? 'not set' : 'not a postgres:// or sqlite:// address'})`, `the SQLite files the app opened`, `${join(root, DATA_FOLDER)}/*.db, *.sqlite and *.sqlite3`]
}

const sqliteFile = (root: string, id: string) => resolve(root, id.slice(SQLITE_PREFIX.length))

// The database a request names (`db`, the first one when it names none), or the response that refuses it.
function pick(root: string, all: DevDatabase[], name: string | null): DevDatabase | Response {
  const chosen = name === null ? all[0] : all.find(({ id }) => id === name)

  return chosen ?? refused(name === null ? `the app has no database: ${searched(root).join(', ')} held none` : `${name} is not a database of the app`, 404)
}

let running = 0
const waiting: (() => void)[] = []

// At most `MAX_WORKERS` reads run at once, the rest wait, so a flood of requests or of runaway queries never spawns many threads.
async function slot(): Promise<void> {
  if (running >= MAX_WORKERS)
    await new Promise<void>(resume => waiting.push(resume))
  else
    running++
}

function release(): void {
  const next = waiting.shift()

  if (next === undefined)
    running--
  else
    next()
}

// One read of a SQLite file in a worker of its own, stopped when it outruns the timeout.
async function sqlite(path: string, task: SqliteTask): Promise<SqliteAnswer> {
  await slot()

  let worker: Worker | undefined

  try {
    const started = worker = new Worker(new URL('./dev-sqlite-worker.ts', import.meta.url))

    return await new Promise<SqliteAnswer>((done) => {
      const timer = setTimeout(done, QUERY_TIMEOUT_MS, { error: `the query ran longer than ${QUERY_TIMEOUT_MS / 1000} seconds` })

      started.onmessage = ({ data }: MessageEvent<SqliteAnswer>) => {
        clearTimeout(timer)
        done(data)
      }
      started.onerror = (event) => {
        clearTimeout(timer)
        done({ error: event.message })
      }
      started.postMessage({ path, task })
    })
  }
  finally {
    worker?.terminate()
    release()
  }
}

function sqliteResponse(answer: SqliteAnswer): Response {
  if ('error' in answer)
    return refused(answer.error, answer.status ?? 400)

  return 'rows' in answer ? Response.json(answer.rows) : Response.json('query' in answer ? answer.query : answer.tables)
}

function refused(error: string, status = 400): Response {
  return Response.json({ error }, { status })
}

function guarded(request: Request): Response | undefined {
  return request.headers.get(HEADER) === null || isCrossSite(request) ? new Response(null, { status: 403 }) : undefined
}

function kindOf(type: string): DevColumn['kind'] {
  if (type === 'bytea')
    return 'binary'

  return type === 'json' || type === 'jsonb' ? 'json' : 'text'
}

interface ColumnRow { schema: string, name: string, estimate: string | number, column: string, type: string, base: string, primary: boolean }

async function tables(sql: SQL): Promise<DevTable[]> {
  const found = await sql.unsafe<ColumnRow[]>(`SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS estimate, a.attname AS "column", format_type(a.atttypid, a.atttypmod) AS type, a.atttypid::regtype::text AS base, coalesce(a.attnum = ANY(ix.indkey), false) AS "primary"
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_index ix ON ix.indrelid = c.oid AND ix.indisprimary
WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%'
ORDER BY n.nspname, c.relname, a.attnum`)
  const byName = new Map<string, DevTable>()

  for (const row of found) {
    const key = `${row.schema}.${row.name}`
    let table = byName.get(key)

    if (table === undefined) {
      table = { schema: row.schema, name: row.name, estimate: Number(row.estimate), columns: [] }
      byName.set(key, table)
    }

    table.columns.push({ name: row.column, type: row.type, kind: kindOf(row.base), primary: row.primary })
  }

  return [...byName.values()]
}

function identifier(name: string): string {
  return `"${name.replace(QUOTE, '""')}"`
}

// What a column sends: its text cut in the database, a bytea as a hex prefix and its size, so a large value is never read whole.
function cell(column: DevColumn): string {
  const name = identifier(column.name)

  if (column.kind === 'binary')
    return `CASE WHEN ${name} IS NULL THEN NULL ELSE '\\x' || encode(substring(${name} FROM 1 FOR ${BINARY_BYTES}), 'hex') || CASE WHEN octet_length(${name}) > ${BINARY_BYTES} THEN '... (' ELSE ' (' END || octet_length(${name}) || ' bytes)' END AS ${name}`

  return `CASE WHEN length(${name}::text) > ${CELL_CHARS} THEN left(${name}::text, ${CELL_CHARS}) || '...' ELSE ${name}::text END AS ${name}`
}

// The databases the app has and the tables of the one asked for (the first by default), or where the tool looked when it found none.
export async function devData(request: Request, root: string): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  const all = databases(root)

  if (all.length === 0)
    return Response.json({ configured: false, databases: [], database: undefined, searched: searched(root), tables: [] } satisfies DevDataOverview)

  const chosen = pick(root, all, new URL(request.url).searchParams.get('db'))

  if (chosen instanceof Response)
    return chosen

  try {
    let list: DevTable[]

    if (chosen.kind === 'postgres') {
      list = await tables(connection(databaseUrl()!))
    }
    else {
      const answer = await sqlite(sqliteFile(root, chosen.id), { kind: 'tables' })

      if (!('tables' in answer))
        return refused('error' in answer ? answer.error : 'the file could not be read', 502)

      list = answer.tables
    }

    return Response.json({ configured: true, databases: all, database: chosen.id, searched: [], tables: list } satisfies DevDataOverview)
  }
  catch (error) {
    return refused(error instanceof Error ? error.message : String(error), 502)
  }
}

// One page of a table's rows, `PAGE_ROWS` at a time by the primary key when there is one, never the table whole.
export async function devRows(request: Request, root: string): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  const params = new URL(request.url).searchParams
  const chosen = pick(root, databases(root), params.get('db'))

  if (chosen instanceof Response)
    return chosen

  const page = Number(params.get('page') ?? 0)

  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE)
    return refused('page is a whole number')

  if (chosen.kind === 'sqlite')
    return sqliteResponse(await sqlite(sqliteFile(root, chosen.id), { kind: 'rows', table: params.get('table') ?? '', page }))

  try {
    const sql = connection(databaseUrl()!)
    const wanted = params.get('table') ?? ''
    const table = (await tables(sql)).find(({ schema, name }) => `${schema}.${name}` === wanted)

    if (table === undefined)
      return refused(`${wanted} is not a table of the database`, 404)

    const keys = table.columns.filter(column => column.primary).map(column => `source.${identifier(column.name)}`)
    const found = await sql.unsafe<Record<string, string | null>[]>(`SELECT ${table.columns.map(cell).join(', ')} FROM ${identifier(table.schema)}.${identifier(table.name)} AS source ORDER BY ${keys.length === 0 ? 'source.ctid' : keys.join(', ')} LIMIT ${PAGE_ROWS + 1} OFFSET ${page * PAGE_ROWS}`)
    const columns = table.columns.map(({ name }) => name)

    return Response.json({ columns, rows: found.slice(0, PAGE_ROWS).map(row => columns.map(name => row[name] ?? null)), page, pageSize: PAGE_ROWS, hasMore: found.length > PAGE_ROWS } satisfies DevRows)
  }
  catch (error) {
    return refused(error instanceof Error ? error.message : String(error), 502)
  }
}

// The statement with its strings, quoted names and comments blanked, or why it cannot be read: what `;`, a first word and a function are looked for in.
function blanked(text: string): { code: string } | { error: string } {
  const unreadable = { error: 'the statement has a string, a quoted name or a comment that never ends' }
  let code = ''

  for (let at = 0; at < text.length;) {
    const char = text[at]!
    const next = text[at + 1]

    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', at)

      code += ' '
      at = end === -1 ? text.length : end
    }
    else if (char === '/' && next === '*') {
      let depth = 1
      let cursor = at + 2

      while (cursor < text.length && depth > 0) {
        if (text.startsWith('/*', cursor)) {
          depth++
          cursor += 2
        }
        else if (text.startsWith('*/', cursor)) {
          depth--
          cursor += 2
        }
        else {
          cursor++
        }
      }

      if (depth > 0)
        return unreadable

      code += ' '
      at = cursor
    }
    else if (char === '\'' || char === '"') {
      // U&"..." and U&'...' spell a name or a string with escapes, which the text checks cannot read.
      if (UNICODE_ESCAPE.test(code))
        return { error: 'U&"..." and U&\'...\' are not allowed: an escaped name hides a function from the checks' }

      // An E'...' string lets a backslash escape the quote.
      const escapes = char === '\'' && at > 0 && ESCAPE_PREFIX.test(text[at - 1]!) && !IDENTIFIER_CHAR.test(text[at - 2] ?? ' ')
      let cursor = at + 1

      for (;;) {
        if (cursor >= text.length)
          return unreadable

        if (escapes && text[cursor] === '\\') {
          cursor += 2
        }
        else if (text[cursor] === char) {
          if (text[cursor + 1] !== char)
            break

          cursor += 2
        }
        else {
          cursor++
        }
      }

      code += ' '
      at = cursor + 1
    }
    else if (char === '$' && DOLLAR_TAG.test(text.slice(at)) && !IDENTIFIER_CHAR.test(text[at - 1] ?? ' ')) {
      const tag = DOLLAR_TAG.exec(text.slice(at))![0]
      const end = text.indexOf(tag, at + tag.length)

      if (end === -1)
        return unreadable

      code += ' '
      at = end + tag.length
    }
    else {
      code += char
      at++
    }
  }

  return { code }
}

// Why the query box refuses a statement, undefined for one it runs: a single SELECT, WITH, VALUES or TABLE, with no `U&` escape and none of the functions in `DENIED_FUNCTION`. The refusals read the text, so a function they do not name (an extension's, or one the app defined) still runs: only the read-only transaction, which Postgres enforces, is a wall.
export function refusedQuery(text: string): string | undefined {
  const blank = blanked(text)

  if ('error' in blank)
    return blank.error

  const statement = blank.code.replace(TRAILING_SEMICOLON, '')
  const raw = text.replace(TRAILING_SEMICOLON, '')

  if (statement.trim() === '')
    return 'the query is empty'

  // On the raw text, as a lexer of our own disagrees with Postgres' on some inputs: a `;` inside a string is refused too.
  if (raw.includes(';'))
    return 'one statement at a time: a `;` chains a second one, even inside a string'

  if (!QUERY_START.test(statement)) {
    const first = FIRST_WORD.exec(statement)?.[1]?.toUpperCase()

    return first === 'SET' ? 'SET is not allowed: the box only reads' : `the box only reads: start with SELECT, WITH, VALUES or TABLE${first === undefined || first === '' ? '' : `, not ${first}`}`
  }

  const denied = DENIED_FUNCTION.exec(raw)?.[1]

  return denied === undefined ? undefined : `${denied} is not allowed: the box only reads`
}

// Runs the box's query in a read-only transaction under a statement timeout, through a cursor so a large result is never read past `QUERY_ROWS` rows.
export async function devQuery(request: Request, root: string): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  let body: { sql?: unknown, db?: unknown }

  try {
    body = await request.json() as typeof body
  }
  catch {
    return refused('the request holds no JSON')
  }

  if (typeof body.sql !== 'string')
    return refused('sql is a text')

  const why = refusedQuery(body.sql)

  if (why !== undefined)
    return refused(why)

  const chosen = pick(root, databases(root), typeof body.db === 'string' ? body.db : null)

  if (chosen instanceof Response)
    return chosen

  if (chosen.kind === 'sqlite')
    return sqliteResponse(await sqlite(sqliteFile(root, chosen.id), { kind: 'query', sql: body.sql.replace(TRAILING_SEMICOLON, '') }))

  let reserved: Awaited<ReturnType<SQL['reserve']>> | undefined

  try {
    reserved = await connection(databaseUrl()!).reserve()
    await reserved.unsafe('BEGIN READ ONLY')
    await reserved.unsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`)
    // Postgres refuses to make a transaction read-write once a query has run in it, so no spelling of that switch gets through; the text checks above are only a first refusal.
    await reserved.unsafe('SELECT 1')
    const text = body.sql.replace(TRAILING_SEMICOLON, '')

    // The statement alone first, for its columns and for Postgres to refuse it as it is: a closing parenthesis or a comment in it cannot reach the wrapped one.
    await reserved.unsafe(`DECLARE kay_dev_columns NO SCROLL CURSOR FOR ${text}\n`)

    const described = (await reserved.unsafe('FETCH 0 FROM kay_dev_columns')) as unknown as { columns: { name: string, type: number }[] }
    const columns = described.columns.map(({ name }) => name)

    if (columns.length === 0)
      return Response.json({ columns, rows: [], truncated: false } satisfies DevQueryResult)

    const cells = described.columns.map(({ type }, at) => cell({ name: `c${at}`, type: '', kind: type === BYTEA_OID ? 'binary' : 'text', primary: false }))

    // Each cell is cut in the database, as the rows view does, so a huge value is never sent; the columns are renamed by position as names may repeat.
    await reserved.unsafe(`DECLARE kay_dev_query NO SCROLL CURSOR FOR SELECT ${cells.join(', ')} FROM (${text}\n) AS source(${columns.map((_, at) => `c${at}`).join(', ')})`)

    const found = await reserved.unsafe<Record<string, string | null>[]>(`FETCH ${QUERY_ROWS + 1} FROM kay_dev_query`)

    return Response.json({ columns, rows: found.slice(0, QUERY_ROWS).map(row => columns.map((_, at) => row[`c${at}`] ?? null)), truncated: found.length > QUERY_ROWS } satisfies DevQueryResult)
  }
  catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
  finally {
    try {
      await reserved?.unsafe('ROLLBACK')
    }
    catch {
      // The connection died with the query: releasing it is all that is left.
    }
    finally {
      await reserved?.release()
    }
  }
}
