import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { setupStore } from '../../../src/server/app-store'
import { scratchDir } from '../../../tests/scratch'
import { pgLoader } from '../src/loaders/pg'
import { contentFile, contentSource } from '../src/loaders/shared'
import { sqliteLoader } from '../src/loaders/sqlite'

afterEach(() => setupStore(undefined))

describe('a loader with no database of its own', () => {
  test('sqliteLoader keeps its table in the SQLite file of the app\'s store', async () => {
    const file = join(await scratchDir('cms-home'), 'app.sqlite')

    setupStore({ database: `sqlite://${file}` })

    const loader = sqliteLoader({ name: 'notes', watch: false })

    await loader.save!({ slug: 'one', data: { title: 'One' } })
    expect(await loader.load({ preview: true })).toHaveLength(1)

    const db = new Database(file)

    expect(db.query('SELECT COUNT(*) AS n FROM kay_content WHERE collection = ?').get('notes')).toEqual({ n: 1 })
    db.close()
  })

  test('pgLoader refuses to start on a store that names no Postgres', async () => {
    setupStore({ database: 'sqlite:///srv/app.sqlite' })
    await expect(pgLoader({ name: 'notes', watch: false }).load({ preview: true })).rejects.toThrow('names no Postgres')
  })
})

describe('the file of a loader with no database of its own', () => {
  const SINK = Symbol.for('kay.log')

  test('is in memory under bun test, so a test site writes no file', async () => {
    const root = await scratchDir('cms-memory')
    const cwd = process.cwd()

    process.chdir(root)

    try {
      expect(contentFile()).toBe(':memory:')
      expect(existsSync(join(root, 'data'))).toBe(false)
    }
    finally {
      process.chdir(cwd)
    }
  })

  test('keeps data/content.db over the app\'s store while it exists, and warns once in production', async () => {
    const root = await scratchDir('cms-both')
    const cwd = process.cwd()
    const mode = process.env.NODE_ENV
    const global = globalThis as { [SINK]?: unknown }
    const sink = global[SINK]
    const lines: string[] = []

    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data/content.db'), '')
    writeFileSync(join(root, 'data/content.sqlite'), '')
    process.chdir(root)
    process.env.NODE_ENV = 'production'
    global[SINK] = (_level: string, message: string, _error?: unknown, _request?: Request, from?: string) => {
      if (from === 'kayjs-cms')
        lines.push(message)
    }
    setupStore({ database: 'sqlite:///srv/app.sqlite' })

    try {
      expect(contentFile()).toBe('data/content.db')
      expect(contentFile()).toBe('data/content.db')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('data/content.db')
    }
    finally {
      global[SINK] = sink
      process.chdir(cwd)
      process.env.NODE_ENV = mode ?? 'test'
    }
  })

  test('prefers data/content.db to data/content.sqlite when both exist', async () => {
    const root = await scratchDir('cms-legacy-wins')
    const cwd = process.cwd()

    mkdirSync(join(root, 'data'))
    writeFileSync(join(root, 'data/content.db'), '')
    writeFileSync(join(root, 'data/content.sqlite'), '')
    process.chdir(root)
    setupStore({ database: 'sqlite:///srv/app.sqlite' })

    try {
      expect(contentFile()).not.toBe('/srv/app.sqlite')
    }
    finally {
      process.chdir(cwd)
    }
  })
})

describe('a pgLoader on pgData given a connection', () => {
  test('uses that connection', async () => {
    const sql = new Bun.SQL('postgres://user@127.0.0.1:1/app')

    setupStore({ sql })
    expect(contentSource()).toBe(sql)
    await sql.close()
  })
})
