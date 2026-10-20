import { authTables } from '@kaynooo/kayjs-auth/pg'
import { Database } from '@kaynooo/pg-orm'
import { env } from '../env'
import { Notice } from './notice'

export const tables = [...authTables, Notice]

// Connects on the first query; in a test, to the copy `kay/test/preload` made for the file.
export const db = new Database({ url: env.DATABASE_URL, tables })
