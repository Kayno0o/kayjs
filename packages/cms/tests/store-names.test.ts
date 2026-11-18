import { describe, expect, it } from 'bun:test'
import * as pg from '../src/loaders/pg'
import * as sqlite from '../src/loaders/sqlite'

describe('the loaders and tables of the cms', () => {
  it('names the Postgres tables of every collection, which an app\'s own sync leaves alone', () => {
    expect(pg.cmsTables).toEqual(['kay_content'])
  })

  it('names its loaders pgCms and sqliteCms alone', () => {
    expect(Object.keys(pg)).toContain('pgCms')
    expect(Object.keys(pg)).not.toContain('pgLoader')
    expect(Object.keys(sqlite)).toContain('sqliteCms')
    expect(Object.keys(sqlite)).not.toContain('sqliteLoader')
  })
})
