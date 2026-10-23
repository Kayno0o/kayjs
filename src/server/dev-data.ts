import process from 'node:process'
import { SQL } from 'bun'
import { isCrossSite } from './actions'

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
const SET_CONFIG = /\bset_config\b/i
const IDENTIFIER_CHAR = /\w/
const ESCAPE_PREFIX = /E/i
const DOLLAR_TAG = /^\$(?:[A-Z_]\w*)?\$/i
const TRAILING_SEMICOLON = /;\s*$/
const QUOTE = /"/g

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

export interface DevDataOverview {
  configured: boolean
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

// The tables of the app's database, or that it has none.
export async function devData(request: Request): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  const url = databaseUrl()

  if (url === undefined)
    return Response.json({ configured: false, tables: [] } satisfies DevDataOverview)

  try {
    return Response.json({ configured: true, tables: await tables(connection(url)) } satisfies DevDataOverview)
  }
  catch (error) {
    return refused(error instanceof Error ? error.message : String(error), 502)
  }
}

// One page of a table's rows, `PAGE_ROWS` at a time by the primary key when there is one, never the table whole.
export async function devRows(request: Request): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  const url = databaseUrl()

  if (url === undefined)
    return refused('the app has no Postgres database: DATABASE_URL is not set to one', 404)

  const params = new URL(request.url).searchParams
  const page = Number(params.get('page') ?? 0)

  if (!Number.isInteger(page) || page < 0 || page > MAX_PAGE)
    return refused('page is a whole number')

  try {
    const sql = connection(url)
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
function blanked(text: string): string | undefined {
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
        return undefined

      code += ' '
      at = cursor
    }
    else if (char === '\'' || char === '"') {
      // An E'...' string lets a backslash escape the quote.
      const escapes = char === '\'' && at > 0 && ESCAPE_PREFIX.test(text[at - 1]!) && !IDENTIFIER_CHAR.test(text[at - 2] ?? ' ')
      let cursor = at + 1

      for (;;) {
        if (cursor >= text.length)
          return undefined

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
        return undefined

      code += ' '
      at = end + tag.length
    }
    else {
      code += char
      at++
    }
  }

  return code
}

// Why the query box refuses a statement, undefined for one it runs: a single SELECT, WITH, VALUES or TABLE, with no `set_config` (which could undo the timeout). Postgres' read-only transaction is the second wall.
export function refusedQuery(text: string): string | undefined {
  const code = blanked(text)

  if (code === undefined)
    return 'the statement has a string, a quoted name or a comment that never ends'

  const statement = code.replace(TRAILING_SEMICOLON, '')
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

  return SET_CONFIG.test(raw) ? 'set_config is not allowed: the box only reads' : undefined
}

function shown(value: unknown): string | null {
  if (value === null || value === undefined)
    return null

  let text: string

  if (value instanceof Uint8Array)
    text = `\\x${Buffer.from(value.subarray(0, BINARY_BYTES)).toString('hex')}${value.length > BINARY_BYTES ? '...' : ''} (${value.length} bytes)`
  else if (value instanceof Date)
    text = Number.isNaN(value.getTime()) ? 'invalid date' : value.toISOString()
  else if (typeof value === 'object')
    text = JSON.stringify(value, (_, inner: unknown) => typeof inner === 'bigint' ? String(inner) : inner)
  else
    text = String(value)

  return text.length > CELL_CHARS ? `${text.slice(0, CELL_CHARS)}...` : text
}

// Runs the box's query in a read-only transaction under a statement timeout, through a cursor so a large result is never read past `QUERY_ROWS` rows.
export async function devQuery(request: Request): Promise<Response> {
  const denied = guarded(request)

  if (denied)
    return denied

  const url = databaseUrl()

  if (url === undefined)
    return refused('the app has no Postgres database: DATABASE_URL is not set to one', 404)

  let body: { sql?: unknown }

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

  let reserved: Awaited<ReturnType<SQL['reserve']>> | undefined

  try {
    reserved = await connection(url).reserve()
    await reserved.unsafe('BEGIN READ ONLY')
    await reserved.unsafe(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`)
    await reserved.unsafe(`DECLARE kay_dev_query NO SCROLL CURSOR FOR ${body.sql.replace(TRAILING_SEMICOLON, '')}\n`)

    const found = await reserved.unsafe<Record<string, unknown>[]>(`FETCH ${QUERY_ROWS + 1} FROM kay_dev_query`)
    const columns = Object.keys(found[0] ?? {})

    return Response.json({ columns, rows: found.slice(0, QUERY_ROWS).map(row => columns.map(name => shown(row[name]))), truncated: found.length > QUERY_ROWS } satisfies DevQueryResult)
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
      reserved?.release()
    }
  }
}
