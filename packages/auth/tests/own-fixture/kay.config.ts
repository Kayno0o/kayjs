import { defineConfig } from 'kay/server'
import { auth } from '../../src/pages'

// An app whose kay.config.ts holds `auth()` and no `src/auth.ts` module.
export default defineConfig({ extensions: [auth()] })
