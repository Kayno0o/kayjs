import { Database } from '@kaynooo/pg-orm'
import { authTables, pgStore } from '../src/pg'
import { storeContract } from './helpers/storeContract'

storeContract('pgStore on SQLite', async () => {
  const db = new Database({ url: 'sqlite://:memory:', tables: [...authTables] })

  await db.sync({ allowDestructive: true })

  return pgStore(db)
})
