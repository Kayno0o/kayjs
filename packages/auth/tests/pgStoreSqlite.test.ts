import { Database } from '@kaynooo/pg-orm'
import { afterAll } from 'bun:test'
import { authTables, pgStore } from '../src/pg'
import { storeContract } from './helpers/storeContract'

const opened: Database[] = []

afterAll(async () => {
  await Promise.all(opened.map(async db => db.close()))
})

storeContract('pgStore on SQLite', async () => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  opened.push(db)
  await db.sync({ allowDestructive: true })

  return pgStore(db)
})
