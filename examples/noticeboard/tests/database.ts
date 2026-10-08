import process from 'node:process'
import { authTables } from '@kaynooo/kayjs-auth/pg'
import { testDatabase } from '@kaynooo/pg-orm'
import { afterAll } from 'bun:test'
import { Notice } from '../src/db/notice'

// Before each test file, run with `bun test --isolate`: a copy of the database the migrations build, dropped once the file is done.
const database = await testDatabase({ url: process.env.DATABASE_URL!, migrationsDir: 'migrations', tables: [...authTables, Notice] })

// Read by src/env.ts, which the test file imports after this, so it never reads the database the copy was made from.
process.env.DATABASE_URL = database.url

afterAll(async () => {
  await database.drop()
})
