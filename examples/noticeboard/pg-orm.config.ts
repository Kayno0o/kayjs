import process from 'node:process'
import { authTables } from '@kaynooo/kayjs-auth/pg'
import { Database, defineConfig } from '@kaynooo/pg-orm'
import { Notice } from './src/db/notice'

// For the `pg-orm` command: `bunx pg-orm generate` writes a migration from what the tables declare, kayjs-auth's included, `bunx pg-orm apply` applies the pending ones.
export default defineConfig({
  db: new Database({ url: process.env.DATABASE_URL, tables: [...authTables, Notice] }),
  migrationsDir: 'migrations',
})
