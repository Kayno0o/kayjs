import { join } from 'node:path'
import { createAuth } from '@kayjs/auth'
import { sqliteAuthStore } from '@kayjs/auth/sqlite'

// Set AUTH_SECRET (at least 32 bytes) in production — see .env.example.
const defaultDb = import.meta.dir.startsWith('/$bunfs')
  ? './data/auth.sqlite'
  : join(import.meta.dir, '../data/auth.sqlite')

export const auth = createAuth({
  store: sqliteAuthStore(process.env.AUTH_DB || defaultDb),
  secret: process.env.AUTH_SECRET || undefined,
  defaultRedirect: '/dashboard',
})
