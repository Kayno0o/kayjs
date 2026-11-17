import { s } from 'kay'
import { defineEnv } from 'kay/server'

// Read once as the server boots. The secret is kay's own, KAY_SECRET, and the public origin its SITE_URL: neither is declared here.
export const env = defineEnv({
  DATABASE_URL: s.string(),
  PORT: s.int({ default: 3000 }),
})
