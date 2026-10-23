import type { DevDataOverview, DevQueryResult, DevRows } from '../src/server/dev-data'
import { join } from 'node:path'
import process from 'node:process'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { closeDevData, refusedQuery } from '../src/server/dev-data'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

const URL_ENV = process.env.TEST_DATABASE_URL
const HEADERS = { 'x-kay-dev': '1' }
const SCHEMA = `kay_dev_data_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`

async function app(options: { dev: boolean, base?: string } = { dev: true }) {
  const dir = await scratchDir('dev-data-')

  await Bun.write(join(dir, 'routes/index.kay'), 'h1 Home\n')

  return pages({ root: dir, routes: 'routes', prebuilt: false, security: false, ...options })
}

type App = Awaited<ReturnType<typeof app>>

async function get(site: App, path: string, headers: Record<string, string> = HEADERS) {
  return site.handle(new Request(`http://localhost${path}`, { headers }))
}

async function query(site: App, sql: string, headers: Record<string, string> = HEADERS) {
  return site.handle(new Request('http://localhost/_kay/dev/data/query', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sql }) }))
}

describe('the query box\'s refusals', () => {
  it('runs one reading statement, a trailing semicolon and comments included', () => {
    for (const sql of ['select 1', 'SELECT 1;', 'with a as (select 1) select * from a', 'values (1), (2)', 'table users', '(select 1) union (select 2)', 'select 1 -- a, b', 'select /* x */ 1'])
      expect(refusedQuery(sql)).toBeUndefined()
  })

  it('refuses writes and DDL by their first word', () => {
    for (const sql of ['insert into t values (1)', 'UPDATE t SET a = 1', 'delete from t', 'drop table t', 'truncate t', 'create table x (a int)', 'copy t to program \'ls\'', 'call p()', 'do $$ begin end $$', 'explain analyze delete from t', ''])
      expect(refusedQuery(sql)).toBeDefined()
  })

  it('refuses a second statement, however it hides behind a comment or a string', () => {
    for (const sql of ['select 1; select 2', 'select 1; drop table t', 'select 1;;', 'select 1; -- x\ndelete from t', 'select \'a\'; delete from t', 'select 1 --\r; commit; delete from t', 'select 1 as x$$a$; commit; delete from t; select 1 as y$$a$', 'select 1 as x$E\'a\\\'; commit; delete from t; --\'', 'select \';\''])
      expect(refusedQuery(sql)).toContain('one statement')
  })

  it('refuses SET and set_config, which could lift the read-only transaction or the timeout', () => {
    expect(refusedQuery('set statement_timeout = 0')).toContain('SET')
    expect(refusedQuery('SET TRANSACTION READ WRITE')).toContain('SET')
    expect(refusedQuery('select set_config(\'statement_timeout\', \'0\', true)')).toContain('set_config')
    expect(refusedQuery('select "set_config"(\'statement_timeout\', \'0\', true)')).toContain('set_config')
  })

  it('refuses a string, a name or a comment that never ends, which could hide a semicolon from the check', () => {
    for (const sql of ['select \'a', 'select "a', 'select /* a', 'select $x$ a'])
      expect(refusedQuery(sql)).toContain('never ends')
  })
})

describe('the dev tool\'s database endpoints', () => {
  const previous = process.env.DATABASE_URL

  afterAll(async () => {
    if (previous === undefined)
      delete process.env.DATABASE_URL
    else
      process.env.DATABASE_URL = previous

    await closeDevData()
  })

  it('says an app with no database has none', async () => {
    delete process.env.DATABASE_URL
    const site = await app()

    expect(await (await get(site, '/_kay/dev/data')).json()).toEqual({ configured: false, tables: [] })
    expect((await get(site, '/_kay/dev/data/rows?table=public.users')).status).toBe(404)
    expect((await query(site, 'select 1')).status).toBe(404)

    process.env.DATABASE_URL = 'sqlite://data/app.sqlite'

    expect(await (await get(site, '/_kay/dev/data')).json()).toEqual({ configured: false, tables: [] })
  })

  it('refuses a request without the dev tool\'s header or from another site', async () => {
    const site = await app()

    expect((await get(site, '/_kay/dev/data', {})).status).toBe(403)
    expect((await get(site, '/_kay/dev/data/rows?table=a.b', {})).status).toBe(403)
    expect((await query(site, 'select 1', {})).status).toBe(403)
    expect((await get(site, '/_kay/dev/data', { ...HEADERS, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await query(site, 'select 1', { ...HEADERS, origin: 'https://evil.example' })).status).toBe(403)
    expect((await query(site, 'select 1', { ...HEADERS, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await get(site, '/_kay/dev/data/rows?table=a.b', { ...HEADERS, origin: 'https://evil.example' })).status).toBe(403)
  })

  it('answers nothing in a production server, the tool and its tabs included', async () => {
    process.env.DATABASE_URL = URL_ENV ?? 'postgres://nobody@127.0.0.1:1/none'
    const site = await app({ dev: false })

    for (const path of ['/_kay/dev/data', '/_kay/dev/data/rows?table=public.users&page=0', '/_kay/dev/tool.js', '/_kay/dev/tab/data.js'])
      expect((await get(site, path)).status).toBe(404)

    expect((await query(site, 'select 1')).status).toBe(404)
  })

  it('serves the tab as browser code, not under a production server, and the base changes nothing about its paths', async () => {
    const site = await app({ dev: true, base: '/shop' })
    const response = await get(site, '/_kay/dev/tab/data.js')
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('export default')
    expect(text).not.toMatch(/^import /m)
    expect((await get(site, '/_kay/dev/tab/nothing.js')).status).toBe(404)
  })

  describe.skipIf(URL_ENV === undefined)('on Postgres', () => {
    let admin: SQL
    let site: App

    beforeAll(async () => {
      process.env.DATABASE_URL = URL_ENV!
      admin = new SQL(URL_ENV!, { max: 1 })
      await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`)
      await admin.unsafe(`CREATE TABLE ${SCHEMA}.users (id serial PRIMARY KEY, name text NOT NULL, bio text)`)
      await admin.unsafe(`INSERT INTO ${SCHEMA}.users (name, bio) VALUES ('Ada', NULL), ('Grace', ${`'${'x'.repeat(1000)}'`})`)
      await admin.unsafe(`CREATE TABLE ${SCHEMA}.blobs (id int PRIMARY KEY, data bytea, doc jsonb)`)
      await admin.unsafe(`INSERT INTO ${SCHEMA}.blobs VALUES (1, decode(repeat('ab', 5000), 'hex'), '{"a": [1, 2, {"b": null}]}'), (2, '\\x0102', NULL)`)
      await admin.unsafe(`CREATE TABLE ${SCHEMA}.big (id int PRIMARY KEY, label text)`)
      await admin.unsafe(`INSERT INTO ${SCHEMA}.big SELECT n, 'row ' || n FROM generate_series(1, 10000) n`)
      await admin.unsafe(`ANALYZE ${SCHEMA}.big`)
      site = await app()
    })

    afterAll(async () => {
      await closeDevData()
      await admin.unsafe(`DROP SCHEMA ${SCHEMA} CASCADE`)
      await admin.close()
    })

    const rows = async (table: string, page = 0) => await (await get(site, `/_kay/dev/data/rows?table=${SCHEMA}.${table}&page=${page}`)).json() as DevRows

    it('lists the tables with their columns, keys and types', async () => {
      const { configured, tables } = await (await get(site, '/_kay/dev/data')).json() as DevDataOverview
      const ours = tables.filter(table => table.schema === SCHEMA)

      expect(configured).toBe(true)
      expect(ours.map(table => table.name)).toEqual(['big', 'blobs', 'users'])
      expect(ours.find(table => table.name === 'users')!.columns).toEqual([
        { name: 'id', type: 'integer', kind: 'text', primary: true },
        { name: 'name', type: 'text', kind: 'text', primary: false },
        { name: 'bio', type: 'text', kind: 'text', primary: false },
      ])
      expect(ours.find(table => table.name === 'blobs')!.columns.map(column => column.kind)).toEqual(['text', 'binary', 'json'])
      expect(ours.find(table => table.name === 'big')!.estimate).toBe(10_000)
      expect(tables.some(table => table.schema === 'pg_catalog')).toBe(false)
    })

    it('pages a table of 10000 rows 50 at a time and never reads it whole', async () => {
      const first = await rows('big')

      expect(first.rows).toHaveLength(50)
      expect(first.hasMore).toBe(true)
      expect(first.rows[0]).toEqual(['1', 'row 1'])

      const last = await rows('big', 199)

      expect(last.rows).toHaveLength(50)
      expect(last.rows.at(-1)).toEqual(['10000', 'row 10000'])
      expect(last.hasMore).toBe(false)
      expect((await rows('big', 200)).rows).toHaveLength(0)
    })

    it('cuts a long text and shows NULL apart from the text', async () => {
      const { rows: users } = await rows('users')

      expect(users[0]).toEqual(['1', 'Ada', null])
      expect(users[1]![2]).toBe(`${'x'.repeat(200)}...`)
    })

    it('shows a bytea as a hex prefix with its size and a jsonb as text', async () => {
      const { rows: blobs } = await rows('blobs')

      expect(blobs[0]).toEqual(['1', `\\x${'ab'.repeat(24)}... (5000 bytes)`, '{"a": [1, 2, {"b": null}]}'])
      expect(blobs[1]).toEqual(['2', '\\x0102 (2 bytes)', null])
    })

    it('refuses a table that is not one, a bad page and an identifier smuggling a statement', async () => {
      expect((await get(site, `/_kay/dev/data/rows?table=${encodeURIComponent(`${SCHEMA}.users"; drop table ${SCHEMA}.users; --`)}`)).status).toBe(404)
      expect((await get(site, '/_kay/dev/data/rows?table=pg_catalog.pg_class')).status).toBe(404)
      expect((await get(site, `/_kay/dev/data/rows?table=${SCHEMA}.users&page=-1`)).status).toBe(400)
      expect((await get(site, `/_kay/dev/data/rows?table=${SCHEMA}.users&page=2000000`)).status).toBe(400)
    })

    it('runs a reading query and shows every kind of value as text', async () => {
      const found = await (await query(site, `select id, name, bio is null as no_bio, now() > '2000-01-01' as recent, 12345678901234567890::numeric as big, '{"a":1}'::jsonb as doc, '\\x00ff'::bytea as bytes from ${SCHEMA}.users order by id`)).json() as DevQueryResult

      expect(found.columns).toEqual(['id', 'name', 'no_bio', 'recent', 'big', 'doc', 'bytes'])
      expect(found.rows[0]).toEqual(['1', 'Ada', 'true', 'true', '12345678901234567890', '{"a":1}', '\\x00ff (2 bytes)'])
      expect(found.truncated).toBe(false)
    })

    it('stops a result at 500 rows without reading the rest', async () => {
      const found = await (await query(site, `select * from ${SCHEMA}.big`)).json() as DevQueryResult

      expect(found.rows).toHaveLength(500)
      expect(found.truncated).toBe(true)
    })

    it('refuses every write, chained statement and SET, and changes nothing', async () => {
      const hostile = [
        `insert into ${SCHEMA}.users (name) values ('Mallory')`,
        `update ${SCHEMA}.users set name = 'x'`,
        `delete from ${SCHEMA}.users`,
        `drop table ${SCHEMA}.users`,
        `truncate ${SCHEMA}.users`,
        `select 1; delete from ${SCHEMA}.users`,
        `select 1;delete from ${SCHEMA}.users;`,
        'set transaction read write',
        'set statement_timeout = 0',
        'select set_config(\'transaction_read_only\', \'off\', true)',
        'commit',
        'begin',
        `copy ${SCHEMA}.users to program 'touch /tmp/kay-dev-data'`,
      ]

      for (const sql of hostile) {
        const response = await query(site, sql)

        expect(response.status, sql).toBe(400)
      }

      expect(await admin.unsafe(`select count(*)::int as n from ${SCHEMA}.users`)).toEqual(expect.arrayContaining([expect.objectContaining({ n: 2 })]))
    })

    it('stops what the database itself refuses as a write: the read-only transaction is the second wall', async () => {
      const writing = [
        `with gone as (delete from ${SCHEMA}.users returning *) select * from gone`,
        `select nextval('${SCHEMA}.users_id_seq')`,
        `select * into ${SCHEMA}.copy from ${SCHEMA}.users`,
      ]

      for (const sql of writing)
        expect((await query(site, sql)).status, sql).toBe(400)

      expect(await admin.unsafe(`select count(*)::int as n from ${SCHEMA}.users`)).toEqual(expect.arrayContaining([expect.objectContaining({ n: 2 })]))
    })

    it('stops every spelling of the switch to read-write in the database itself, a unicode-escaped function name included', async () => {
      const switching = [
        'select set_config(\'transaction_read_only\', \'off\', true)',
        'select "set_config"(\'transaction_read_only\', \'off\', true)',
        'select U&"set\\005fconfig"(\'transaction_read_only\', \'off\', true)',
      ]

      for (const sql of switching) {
        const found = await query(site, sql)

        expect(found.status, sql).toBe(400)
      }

      const unescaped = await (await query(site, switching[2]!)).json() as { error: string }

      expect(unescaped.error).toContain('read-write')

      for (const sql of ['set transaction_read_only = off', 'set transaction read write'])
        expect((await query(site, sql)).status, sql).toBe(400)

      const insert = await query(site, `insert into ${SCHEMA}.users (name) values ('Mallory')`)

      expect(insert.status).toBe(400)
      expect(await admin.unsafe(`select count(*)::int as n from ${SCHEMA}.users`)).toEqual(expect.arrayContaining([expect.objectContaining({ n: 2 })]))
      expect((await query(site, 'select pg_terminate_backend(1)')).status).toBe(400)
    })

    it('gives up on a statement past the timeout and answers the next query', async () => {
      const slow = await query(site, 'select pg_sleep(30)')
      const body = await slow.json() as { error: string }

      expect(slow.status).toBe(400)
      expect(body.error).toContain('statement timeout')
      expect((await query(site, 'select 1 as one')).status).toBe(200)
    }, 15_000)

    it('keeps the session clean: a failed query leaves no transaction behind', async () => {
      await query(site, 'select 1/0')

      const found = await (await query(site, 'select current_setting(\'transaction_read_only\') as ro, current_setting(\'statement_timeout\') as timeout')).json() as DevQueryResult

      expect(found.rows[0]).toEqual(['on', '5s'])
      expect(await (await get(site, '/_kay/dev/data')).json()).toMatchObject({ configured: true })
    })
  })
})
