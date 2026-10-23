import { Database } from '@kaynooo/pg-orm'
import { authTables, pgStore } from '../../src/pg'
import { userRecord } from './app'

// A process writing users into a shared SQLite file: `writeUsers.ts <file> <prefix> <count>`.
const [file, prefix, count] = process.argv.slice(2) as [string, string, string]
const db = new Database({ url: `sqlite://${file}`, tables: [...authTables] })

await db.sync()

const store = pgStore(db)

for (let index = 0; index < Number(count); index++)
  await store.users.create(userRecord({ id: `${prefix}${index}`, email: `${prefix}${index}@example.com` }))

await db.close()
