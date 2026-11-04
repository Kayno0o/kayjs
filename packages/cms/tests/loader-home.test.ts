import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { setupStore } from '../../../src/server/app-store'
import { scratchDir } from '../../../tests/scratch'
import { pgLoader } from '../src/loaders/pg'
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
