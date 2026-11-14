import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { APP_SQLITE_FILE, defaultSqliteFile } from '../src/server/app-database'
import { scratchDir } from './scratch'

describe('defaultSqliteFile', () => {
  it('is data/app.sqlite when no file of an older default exists', async () => {
    const root = await scratchDir('default-sqlite-none')

    expect(defaultSqliteFile(['data/sessions.sqlite'], root)).toBe(APP_SQLITE_FILE)
    expect(defaultSqliteFile([], root)).toBe(APP_SQLITE_FILE)
  })

  it('keeps the first older file that exists, so an upgrade loses no data', async () => {
    const root = await scratchDir('default-sqlite-legacy')

    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data/auth.sqlite'), '')
    expect(defaultSqliteFile(['data/auth.db', 'data/auth.sqlite'], root)).toBe('data/auth.sqlite')

    writeFileSync(join(root, 'data/auth.db'), '')
    expect(defaultSqliteFile(['data/auth.db', 'data/auth.sqlite'], root)).toBe('data/auth.db')
  })

  it('does not take the app\'s own file for a legacy one', async () => {
    const root = await scratchDir('default-sqlite-app')

    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, APP_SQLITE_FILE), '')
    expect(defaultSqliteFile(['data/jobs.sqlite'], root)).toBe(APP_SQLITE_FILE)
  })
})
