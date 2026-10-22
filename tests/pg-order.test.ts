import { join } from 'node:path'
import { Glob } from 'bun'
import { expect, it } from 'bun:test'

const root = join(import.meta.dir, '..')

const QUOTE_OR_END = /['"`;]/
const SELECTS = /\bSELECT\b/i
const TEXT_CAST = /\b(\w+)::text\b(?!\s+AS\s+(?!\1\b))/gi
const ORDER_BY = /\bORDER BY\s+([^;]*)/i
const ITEM_NAME = /^\s*(\w+)(?![\w.(])/

// The SQL strings selecting a column cast to text whose bare name their ORDER BY then sorts by: Postgres sorts by the text output column, so '100' comes before '99'.
function sqlOrderedByTextCast(source: string): string[] {
  return source.split(QUOTE_OR_END).filter((sql) => {
    if (!SELECTS.test(sql))
      return false

    const cast = new Set([...sql.matchAll(TEXT_CAST)].map(match => match[1]))
    const items = ORDER_BY.exec(sql)?.[1]?.split(',') ?? []

    return items.some(item => cast.has(ITEM_NAME.exec(item)?.[1] ?? ''))
  })
}

const files = [
  ...new Glob('src/server/pg-*.ts').scanSync(root),
  ...new Glob('packages/*/src/**/pg*.ts').scanSync(root),
]

it('finds the four reads that sorted by the text of a cast column', () => {
  const before = [
    'db`SELECT id::text, message FROM kay_events WHERE id > ${from}::bigint AND origin != ${PROCESS} ORDER BY id`',
    '\'SELECT seq::text AS seq FROM kay_live_events ORDER BY seq DESC LIMIT $1\'',
    '\'SELECT seq::text AS seq, id, key FROM kay_live_events WHERE seq > $1::bigint AND origin != $2 ORDER BY seq\'',
    '\'SELECT id::text, room, text, skipped, recipient FROM kay_room_messages WHERE id > $1::bigint AND process <> $2 ORDER BY id\'',
  ]

  for (const line of before)
    expect(sqlOrderedByTextCast(line)).toHaveLength(1)

  expect(sqlOrderedByTextCast('\'SELECT id::text FROM t ORDER BY t.id\'')).toEqual([])
  expect(sqlOrderedByTextCast('\'SELECT data::text AS data FROM t ORDER BY place\'')).toEqual([])
})

it('has no pg query ordering by the bare name of a column it selects as text', async () => {
  expect(files.length).toBeGreaterThan(5)

  const found: string[] = []

  for (const file of files) {
    for (const sql of sqlOrderedByTextCast(await Bun.file(join(root, file)).text()))
      found.push(`${file}: ${sql}`)
  }

  expect(found).toEqual([])
})
