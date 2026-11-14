import { describe, expect, it } from 'bun:test'
import * as pg from '../src/loaders/pg'
import * as sqlite from '../src/loaders/sqlite'

describe('the loaders and tables of the cms', () => {
  it('names the Postgres tables of every collection, which an app\'s own sync leaves alone', () => {
    expect(pg.cmsTables).toEqual(['kay_content'])
  })

  it('keeps pgLoader and sqliteLoader of before 1.105 as pgCms and sqliteCms', () => {
    expect(pg.pgLoader).toBe(pg.pgCms)
    expect(sqlite.sqliteLoader).toBe(sqlite.sqliteCms)
  })
})
