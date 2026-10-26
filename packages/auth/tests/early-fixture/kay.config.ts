import { defineConfig, sqliteData } from 'kay/server'
import { auth } from '../../src/pages'

// An app whose sessions live in a store the config names, and whose `src/auth.ts` module a test imports before any site exists.
export default defineConfig({ extensions: [auth({ module: './src/auth', pages: false })], store: sqliteData(':memory:') })
